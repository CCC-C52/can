import JSZip from "jszip";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { q, q1, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { config } from "@/lib/config";
import { findValidApproval, requiredScopes, type OutputVersion } from "./outputs";
import { capabilityReady } from "./connections";
import { getMedia, readMediaFile, recordUsage, type MediaAsset } from "./media";
import { applyShopifyProposal } from "@/lib/adapters/shopify";
import { publishInstagram } from "@/lib/adapters/instagram";
import { UncertainOutcomeError } from "@/lib/adapters/http";
import { getStorage, s3Client } from "@/lib/storage";
import { canonicalJson, sha256 } from "@/lib/security/crypto";

// DIŞ İŞLEM KAPISI — dış platforma yazan TÜM işlemler buradan geçer.
// Onay kontrolü ajan talimatında değil, bu sunucu kodunda zorunlu kılınır.

export type ActionType = "publish" | "store_update" | "price_change" | "ad_launch";

export class ApprovalRequiredError extends Error {}
export class ConnectionMissingError extends Error {}

export type ExternalAction = {
  id: string;
  brand_id: string;
  action_type: string;
  provider: string;
  output_version_id: string | null;
  approval_id: string | null;
  idempotency_key: string;
  status: string;
  request: any;
  response: any;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function isDemoContent(v: OutputVersion) {
  return v.is_demo || canonicalJson(v.content).includes("[DEMO]");
}

export async function listExternalActions(brandId: string, limit = 100) {
  return q<ExternalAction>(`SELECT * FROM external_actions WHERE brand_id = $1 ORDER BY created_at DESC LIMIT $2`, [brandId, limit]);
}

/**
 * Dış işlemi yürütür.
 * - Onay: en güncel sürüm + aynı içerik hash'i + gerekli kapsam (fiyat değişikliği ayrıca price_change ister)
 * - Demo içerik dış platforma gönderilmez
 * - Idempotency: aynı anahtar veya aynı sürüm+hedef için ikinci işlem oluşmaz
 * - Bağlantı yoksa sahte başarı yok: hata döner
 * - Sonuç belirsizse "unknown" olarak işaretlenir ve kullanıcı kontrol edene kadar tekrar gönderilmez
 */
export async function executeExternalAction(args: {
  brandId: string;
  outputVersionId: string;
  actionType: ActionType;
  idempotencyKey: string;
  target?: { postId?: string; manual?: boolean };
}): Promise<ExternalAction> {
  const { brandId, outputVersionId, actionType } = args;
  if (!args.idempotencyKey || args.idempotencyKey.length < 8) throw new Error("Geçersiz idempotency anahtarı.");

  // Aynı anahtarla daha önce oluşturulmuş işlem varsa onu döndür (çift işlem yok)
  const byKey = await q1<ExternalAction>(`SELECT * FROM external_actions WHERE idempotency_key = $1`, [args.idempotencyKey]);
  if (byKey) {
    if (byKey.brand_id !== brandId) throw new Error("İşlem anahtarı başka bir markaya ait.");
    return byKey;
  }

  const meta = await q1<OutputVersion & { kind: string }>(
    `SELECT v.*, o.kind FROM output_versions v JOIN outputs o ON o.id = v.output_id WHERE v.id = $1 AND v.brand_id = $2`,
    [outputVersionId, brandId],
  );
  if (!meta) throw new Error("Çıktı sürümü bulunamadı.");

  const needed = new Set<string>([actionType]);
  if (actionType === "store_update" && requiredScopes(meta.kind, meta.content).includes("price_change")) needed.add("price_change");
  let approvalId: string | null = null;
  for (const scope of needed) {
    const check = await findValidApproval(brandId, outputVersionId, scope);
    if (!check.ok) {
      await audit({ brandId, actor: "system", action: "external.blocked", message: `Dış işlem engellendi (${actionType}): ${check.reason}`, data: { outputVersionId } });
      throw new ApprovalRequiredError(check.reason);
    }
    approvalId = check.approval.id;
  }
  if (isDemoContent(meta)) {
    await audit({ brandId, actor: "system", action: "external.blocked", message: `Dış işlem engellendi: DEMO içerik dış platforma gönderilemez.` });
    throw new ApprovalRequiredError("DEMO içerik dış platforma gönderilemez. İçeriği düzenleyip [DEMO] işaretlerini kaldırın ve yeni sürümü onaylayın.");
  }

  const { provider, run } = await planAction(brandId, meta, actionType, args.target);

  // Aynı sürüm + aynı hedef için tamamlanmış/süren/belirsiz işlem varsa yenisini oluşturma
  const targetKey = sha256(`${outputVersionId}:${actionType}:${provider}:${args.target?.postId ?? "*"}`);
  const dupe = await q1<ExternalAction>(
    `SELECT * FROM external_actions WHERE brand_id = $1 AND request->>'target_key' = $2 AND status IN ('pending','executing','succeeded','unknown','manual_export') LIMIT 1`,
    [brandId, targetKey],
  );
  if (dupe) return dupe;

  const inserted = await q1<ExternalAction>(
    `INSERT INTO external_actions (brand_id, action_type, provider, output_version_id, approval_id, idempotency_key, status, request)
     VALUES ($1,$2,$3,$4,$5,$6,'executing',$7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [brandId, actionType, provider, outputVersionId, approvalId, args.idempotencyKey, JSON.stringify({ target: args.target ?? null, target_key: targetKey })],
  );
  if (!inserted) return (await q1<ExternalAction>(`SELECT * FROM external_actions WHERE idempotency_key = $1`, [args.idempotencyKey]))!;

  let status = "succeeded", response: unknown = null, error: string | null = null;
  try {
    const r = await run();
    status = r.status ?? "succeeded";
    response = r.response;
    if (r.error) error = r.error;
  } catch (err) {
    if (err instanceof UncertainOutcomeError) {
      status = "unknown";
      error = err.message;
    } else {
      status = "failed";
      error = (err as Error).message;
    }
  }
  const row = await q1<ExternalAction>(
    `UPDATE external_actions SET status = $2, response = $3, error = $4, updated_at = now() WHERE id = $1 RETURNING *`,
    [inserted.id, status, JSON.stringify(response), error],
  );
  await audit({ brandId, actor: "user", action: `external.${status}`, message: `Dış işlem (${actionType} → ${provider}): ${status}${error ? ` — ${error}` : ""}`, data: { actionId: inserted.id } });
  await syncCalendar(brandId, outputVersionId, args.target?.postId, row!);
  return row!;
}

async function planAction(
  brandId: string,
  v: OutputVersion & { kind: string },
  actionType: ActionType,
  target?: { postId?: string; manual?: boolean },
): Promise<{ provider: string; run: () => Promise<{ status?: string; response: unknown; error?: string }> }> {
  if (actionType === "store_update" || actionType === "price_change") {
    if (v.kind !== "shopify_proposal") throw new Error("Bu çıktı mağaza güncellemesi içermiyor.");
    const ready = await capabilityReady("store_write", brandId);
    if (!ready.ready) throw new ConnectionMissingError(`Shopify bağlı değil — işlem yapılmadı. (${ready.reason})`);
    return {
      provider: "shopify",
      run: async () => {
        const r = await applyShopifyProposal(brandId, v.content);
        return { status: r.allOk ? "succeeded" : "failed", response: r, error: r.allOk ? undefined : "Bazı değişiklikler uygulanamadı (ayrıntılar yanıtta)." };
      },
    };
  }
  if (actionType === "publish") {
    if (v.kind !== "social_package") throw new Error("Bu çıktı yayın paketi değil.");
    const post = (v.content.posts ?? []).find((p: any) => p.id === target?.postId);
    if (!post) throw new Error("Yayınlanacak gönderi bulunamadı.");
    const media = await resolvePostMedia(brandId, v, post);
    if (post.platform === "instagram" && !target?.manual) {
      const ready = await capabilityReady("social_publish_instagram", brandId);
      if (!ready.ready) throw new ConnectionMissingError(`Instagram bağlı değil — yayın yapılmadı. Manuel yayın paketi indirebilirsiniz.`);
      if (!media.length) throw new Error("Gönderi için render edilmiş medya yok.");
      if (config.storageDriver !== "s3") throw new ConnectionMissingError("Instagram medyayı herkese açık URL'den çeker; S3 depolama yapılandırılmadan yayın yapılamaz. Manuel paket kullanın.");
      return {
        provider: "instagram",
        run: async () => {
          const url = await presign(media[0]);
          const r = await publishInstagram(brandId, { mediaUrl: url, isVideo: media[0].kind === "video", format: post.format === "reel" ? "reel" : post.format === "story" ? "story" : "feed", caption: captionOf(post) });
          await recordUsage(brandId, media[0].id, { channel: "instagram", note: r.mediaId });
          return { response: r };
        },
      };
    }
    // TikTok ve diğerleri: otomatik yayın desteklenmiyor → manuel yayın paketi
    return {
      provider: `${post.platform}_manual`,
      run: async () => ({ status: "manual_export", response: await buildManualPackage(brandId, v, post, media) }),
    };
  }
  throw new ConnectionMissingError("Reklam başlatma/bütçe değişikliği adaptörü bu sürümde bağlı değil (Meta Marketing API). İşlem yapılmadı.");
}

function captionOf(post: any) {
  const tags = (post.hashtags ?? []).filter((t: string) => !(post.caption ?? "").includes(t));
  return [post.caption, tags.join(" ")].filter(Boolean).join("\n\n");
}

/** Gönderinin medya referanslarını (brief/video kimliği → render edilmiş varlık) çözer. Yalnızca aynı markanın dosyaları. */
export async function resolvePostMedia(brandId: string, v: OutputVersion, post: any): Promise<MediaAsset[]> {
  const out: MediaAsset[] = [];
  for (const ref of post.media_refs ?? []) {
    if (/^[0-9a-f-]{36}$/.test(ref)) {
      const m = await getMedia(brandId, ref);
      if (m) out.push(m);
      continue;
    }
    // Brief/video kimliği: aynı projedeki render çıktılarında ara
    const rows = await q<MediaAsset>(
      `SELECT m.* FROM media_assets m
       JOIN output_versions ov ON ov.id = m.source_output_version_id
       JOIN outputs o ON o.id = ov.output_id
       WHERE m.brand_id = $1 AND o.project_id = (SELECT project_id FROM outputs WHERE id = $2) AND m.tags::text LIKE $3
       ORDER BY m.created_at DESC LIMIT 1`,
      [brandId, v.output_id, `%"ref:${ref}"%`],
    );
    out.push(...rows);
  }
  return out;
}

async function presign(asset: MediaAsset) {
  return getSignedUrl(s3Client(), new GetObjectCommand({ Bucket: config.s3.bucket!, Key: asset.storage_key }), { expiresIn: 3600 });
}

/** Manuel yayın paketi: medya dosyaları + açıklama + kapak metni + bilgi dosyası (zip). */
export async function buildManualPackage(brandId: string, v: OutputVersion, post: any, media: MediaAsset[]) {
  const zip = new JSZip();
  zip.file("caption.txt", captionOf(post));
  zip.file("cover_text.txt", post.cover_text ?? "");
  zip.file(
    "README.txt",
    [
      `Platform: ${post.platform} (${post.format})`,
      `Önerilen zaman: ${post.suggested_datetime}`,
      `Çıktı sürümü: ${v.version} (${v.id})`,
      media.length ? `Medya: ${media.map((m) => m.filename).join(", ")}` : "UYARI: Bu gönderi için render edilmiş medya yok; medyayı ayrıca hazırlayın.",
      "Bu paket otomatik yayınlanmadı. Dosyaları platform uygulamasından manuel yükleyin.",
    ].join("\n"),
  );
  for (const m of media) zip.file(`media/${m.filename}`, await readMediaFile(m));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const key = `brands/${brandId}/exports/${sha256(buf)}.zip`;
  await getStorage().put(key, buf, "application/zip");
  return { storage_key: key, files: media.map((m) => m.filename), size: buf.length };
}

async function syncCalendar(brandId: string, versionId: string, postId: string | undefined, action: ExternalAction) {
  if (!postId) return;
  const status = action.status === "succeeded" ? "published" : action.status === "manual_export" ? "manual_export" : action.status === "failed" ? "failed" : null;
  if (!status) return;
  await q(
    `UPDATE calendar_entries SET status = $3, external_action_id = $4, updated_at = now()
     WHERE brand_id = $1 AND output_id = (SELECT output_id FROM output_versions WHERE id = $2) AND title LIKE $5`,
    [brandId, versionId, status, action.id, `${postId}%`],
  );
}

/** Belirsiz sonuçlu işlemin kullanıcı tarafından platformda kontrol edildikten sonra işaretlenmesi. */
export async function reconcileAction(brandId: string, actionId: string, outcome: "succeeded" | "failed", note?: string) {
  const row = await q1<ExternalAction>(
    `UPDATE external_actions SET status = $3, error = COALESCE($4, error), updated_at = now() WHERE id = $1 AND brand_id = $2 AND status = 'unknown' RETURNING *`,
    [actionId, brandId, outcome, note ?? null],
  );
  if (!row) throw new Error("Yalnızca sonucu belirsiz işlemler işaretlenebilir.");
  await audit({ brandId, actor: "user", action: "external.reconcile", message: `Belirsiz işlem kullanıcı kontrolüyle '${outcome}' olarak işaretlendi` });
  return row;
}

