import { getStorage } from "@/lib/storage";
import { isUuid } from "@/lib/ids";
import { q, q1, tx, type Queryable, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { contentHash } from "@/lib/security/crypto";
import { OUTPUT_SCHEMAS, type SpecialistId } from "@/lib/agents/schemas";
import { buildBrandContext } from "@/lib/agents/context";
import { proposeLessonFromRejection } from "./brand-memory";
import { referencedAssetIds, runRuleChecks } from "@/lib/agents/qa-rules";

export type Output = {
  id: string;
  brand_id: string;
  project_id: string | null;
  task_id: string | null;
  agent: string;
  kind: string;
  title: string;
  current_version: number;
  created_at: string;
  updated_at: string;
};

export type OutputVersion = {
  id: string;
  brand_id: string;
  output_id: string;
  version: number;
  content: any;
  content_hash: string;
  created_by: string;
  generator: string;
  is_demo: boolean;
  qa_report: any;
  asset_ids: string[];
  created_at: string;
};

export type Approval = {
  id: string;
  brand_id: string;
  output_id: string;
  output_version_id: string;
  content_hash: string;
  decision: "approved" | "rejected";
  scopes: string[];
  note: string | null;
  revoked_at: string | null;
  created_at: string;
};

export async function createOutput(
  o: { brandId: string; projectId: string | null; taskId: string | null; agent: string; kind: string; title: string },
  db: Queryable = getPool(),
) {
  return (await q1<Output>(
    `INSERT INTO outputs (brand_id, project_id, task_id, agent, kind, title) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [o.brandId, o.projectId, o.taskId, o.agent, o.kind, o.title],
    db,
  ))!;
}

/** Yeni sürüm ekler. Sürümler değişmez; düzenleme her zaman yeni sürüm oluşturur. */
export async function addVersion(
  v: { brandId: string; outputId: string; content: unknown; createdBy: string; generator: string; isDemo: boolean; qaReport?: unknown; assetIds?: string[] },
  db?: Queryable,
): Promise<OutputVersion> {
  const run = async (c: Queryable) => {
    const out = await q1<Output>(`SELECT * FROM outputs WHERE id = $1 AND brand_id = $2 FOR UPDATE`, [v.outputId, v.brandId], c);
    if (!out) throw new Error("Çıktı bulunamadı");
    const next = out.current_version + 1;
    const row = await q1<OutputVersion>(
      `INSERT INTO output_versions (brand_id, output_id, version, content, content_hash, created_by, generator, is_demo, qa_report, asset_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [v.brandId, v.outputId, next, JSON.stringify(v.content), contentHash(v.content), v.createdBy, v.generator, v.isDemo, v.qaReport === undefined ? null : JSON.stringify(v.qaReport), v.assetIds ?? []],
      c,
    );
    await q(`UPDATE outputs SET current_version = $2, updated_at = now() WHERE id = $1`, [v.outputId, next], c);
    return row!;
  };
  return db ? run(db) : tx(run);
}

export async function setVersionQa(versionId: string, qa: unknown, db: Queryable = getPool()) {
  await q(`UPDATE output_versions SET qa_report = $2 WHERE id = $1`, [versionId, JSON.stringify(qa)], db);
}

export async function attachAssetsToVersion(versionId: string, assetIds: string[], db: Queryable = getPool()) {
  await q(`UPDATE output_versions SET asset_ids = (SELECT ARRAY(SELECT DISTINCT unnest(asset_ids || $2::uuid[]))) WHERE id = $1`, [versionId, assetIds], db);
}

export async function getOutput(brandId: string, id: string, db: Queryable = getPool()) {
  if (!isUuid(id)) return null;
  return q1<Output>(`SELECT * FROM outputs WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
}

export async function listOutputs(brandId: string, opts: { projectId?: string; limit?: number } = {}, db: Queryable = getPool()) {
  return q<Output & { is_demo: boolean; verdict: string | null; approval: string | null; generator: string | null }>(
    `SELECT o.*, v.is_demo, v.generator, v.qa_report->>'verdict' AS verdict,
       (SELECT a.decision FROM approvals a WHERE a.output_version_id = v.id AND a.revoked_at IS NULL ORDER BY a.created_at DESC LIMIT 1) AS approval
     FROM outputs o
     LEFT JOIN output_versions v ON v.output_id = o.id AND v.version = o.current_version
     WHERE o.brand_id = $1 AND ($2::uuid IS NULL OR o.project_id = $2) AND o.kind <> 'plan'
     ORDER BY o.created_at DESC LIMIT $3`,
    [brandId, opts.projectId ?? null, opts.limit ?? 200],
    db,
  );
}

export async function listVersions(brandId: string, outputId: string, db: Queryable = getPool()) {
  return q<OutputVersion>(`SELECT * FROM output_versions WHERE output_id = $1 AND brand_id = $2 ORDER BY version DESC`, [outputId, brandId], db);
}

export async function getVersion(brandId: string, versionId: string, db: Queryable = getPool()) {
  if (!isUuid(versionId)) return null;
  return q1<OutputVersion>(`SELECT * FROM output_versions WHERE id = $1 AND brand_id = $2`, [versionId, brandId], db);
}

export async function getCurrentVersion(brandId: string, outputId: string, db: Queryable = getPool()) {
  if (!isUuid(outputId)) return null;
  return q1<OutputVersion>(
    `SELECT v.* FROM output_versions v JOIN outputs o ON o.id = v.output_id AND v.version = o.current_version
     WHERE o.id = $1 AND o.brand_id = $2`,
    [outputId, brandId],
    db,
  );
}

export async function listApprovals(brandId: string, outputId: string, db: Queryable = getPool()) {
  return q<Approval & { version: number }>(
    `SELECT a.*, v.version FROM approvals a JOIN output_versions v ON v.id = a.output_version_id
     WHERE a.output_id = $1 AND a.brand_id = $2 ORDER BY a.created_at DESC`,
    [outputId, brandId],
    db,
  );
}

// ---------------------------------------------------------------- Dış işlem kapsamları

/** Çıktı içeriğinden, hangi dış işlemler için onay gerektiğini SUNUCU KODU belirler (ajan beyanına güvenilmez). */
export function requiredScopes(kind: string, content: any): string[] {
  const scopes = new Set<string>(["content"]);
  if (kind === "shopify_proposal") {
    const changes: any[] = content?.product_changes ?? [];
    if (changes.length || content?.collections?.length || content?.pages?.length) scopes.add("store_update");
    if (changes.some((c) => c.field === "price" || c.field === "compare_at_price")) scopes.add("price_change");
  }
  if (kind === "social_package" && (content?.posts ?? []).length) scopes.add("publish");
  if (kind === "ad_plan") scopes.add("ad_launch");
  return [...scopes];
}

// ---------------------------------------------------------------- Kullanıcı düzenlemesi

export class ValidationError extends Error {}

/** Kullanıcı düzenlemesi: şema doğrulaması + kural tabanlı kontrol, yeni sürüm. Eski onaylar bu sürüm için geçersizdir. */
export async function editOutput(brandId: string, outputId: string, content: unknown, db?: Queryable) {
  const out = await getOutput(brandId, outputId, db);
  if (!out) throw new ValidationError("Çıktı bulunamadı");
  const schema = (OUTPUT_SCHEMAS as Record<string, any>)[out.agent];
  let valid = content;
  if (schema) {
    const r = schema.safeParse(content);
    if (!r.success) throw new ValidationError(`İçerik şemaya uymuyor: ${r.error.issues.slice(0, 3).map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    valid = r.data;
  }
  const ctx = await buildBrandContext(brandId, db, { includeAssetIds: referencedAssetIds(out.agent, valid) });
  const qa = out.agent in OUTPUT_SCHEMAS && out.agent !== "quality"
    ? { ...runRuleChecks(out.agent as SpecialistId, valid as any, ctx, { isDemo: false }), sources: ["rules"], note: "Kullanıcı düzenlemesi sonrası kural tabanlı kontrol" }
    : null;
  const prev = await getCurrentVersion(brandId, outputId, db);
  const v = await addVersion({ brandId, outputId, content: valid, createdBy: "user", generator: "user", isDemo: false, qaReport: qa, assetIds: prev?.asset_ids ?? [] }, db);
  await audit({ brandId, projectId: out.project_id, taskId: out.task_id, actor: "user", action: "output.edit", message: `"${out.title}" düzenlendi → sürüm ${v.version}`, data: { versionId: v.id } }, db);
  return v;
}

// ---------------------------------------------------------------- Onay / ret

export async function decide(
  brandId: string,
  versionId: string,
  decision: "approved" | "rejected",
  opts: { note?: string; scopes?: string[] } = {},
) {
  return tx(async (c) => {
    const v = await q1<OutputVersion & { kind: string; agent: string; current_version: number; task_id: string | null; project_id: string | null; title: string }>(
      `SELECT v.*, o.kind, o.agent, o.current_version, o.task_id, o.project_id, o.title FROM output_versions v JOIN outputs o ON o.id = v.output_id
       WHERE v.id = $1 AND v.brand_id = $2 FOR UPDATE OF o`,
      [versionId, brandId],
      c,
    );
    if (!v) throw new ValidationError("Sürüm bulunamadı");
    if (v.version !== v.current_version) throw new ValidationError("Yalnızca en güncel sürüm onaylanabilir veya reddedilebilir.");
    if (contentHashOf(v.content) !== v.content_hash) throw new ValidationError("İçerik bütünlüğü doğrulanamadı.");
    // Video planı: doğrulanmış bir MP4 üretilmeden onay verilemez (ret her zaman mümkün)
    if (decision === "approved" && v.kind === "video_plan" && (v.content?.videos ?? []).some((x: any) => x.mode === "edit_existing" || x.mode === "generate_new")) {
      const mp4 = await q1<{ id: string; storage_key: string }>(
        `SELECT id, storage_key FROM media_assets WHERE brand_id = $1 AND id = ANY($2::uuid[]) AND kind = 'video'
           AND (generation_method = 'ffmpeg_edit' OR generation_method LIKE 'ai_video:%') AND size_bytes > 0 LIMIT 1`,
        [brandId, v.asset_ids ?? []],
        c,
      );
      if (!mp4 || !(await getStorage().exists(mp4.storage_key))) {
        throw new ValidationError("Bu sürüm için doğrulanmış bir MP4 henüz yok; video render tamamlanmadan onaylanamaz. Reddedebilir veya revizyon isteyebilirsiniz.");
      }
    }
    const allowed = requiredScopes(v.kind, v.content);
    const scopes = decision === "approved" ? (opts.scopes?.length ? opts.scopes.filter((s) => allowed.includes(s)) : allowed) : [];
    if (decision === "approved" && !scopes.includes("content")) scopes.unshift("content");
    const a = await q1<Approval>(
      `INSERT INTO approvals (brand_id, output_id, output_version_id, content_hash, decision, scopes, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [brandId, v.output_id, v.id, v.content_hash, decision, scopes, opts.note ?? null],
      c,
    );
    // Ret notu, sahip onaylarsa kullanılacak bir ders önerisine dönüşür (otomatik etkinleşmez)
    if (decision === "rejected") await proposeLessonFromRejection(brandId, { approvalId: a!.id, note: opts.note, agent: v.agent, outputTitle: v.title }, c);
    if (v.kind === "social_package") {
      await q(`UPDATE calendar_entries SET status = $3, updated_at = now() WHERE brand_id = $1 AND output_id = $2 AND status IN ('draft','awaiting_approval','approved')`,
        [brandId, v.output_id, decision === "approved" ? "approved" : "draft"], c);
    }
    if (v.task_id) {
      if (decision === "approved") {
        await q(`UPDATE tasks SET status = 'completed', finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'approval_pending'`, [v.task_id], c);
      }
    }
    await audit(
      { brandId, projectId: v.project_id, taskId: v.task_id, actor: "user", action: `approval.${decision}`, message: `"${v.title}" sürüm ${v.version} ${decision === "approved" ? "onaylandı" : "reddedildi"}${scopes.length ? ` (kapsam: ${scopes.join(", ")})` : ""}${opts.note ? ` — ${opts.note}` : ""}`, data: { approvalId: a!.id, versionId, contentHash: v.content_hash } },
      c,
    );
    return a!;
  });
}

function contentHashOf(content: unknown) {
  return contentHash(content);
}

/**
 * Bir dış işlem için geçerli onayı bulur. Koşullar (sunucuda zorunlu):
 *  - Onay en güncel sürüme ait olmalı,
 *  - Onaylanan içerik hash'i sürüm içeriğiyle aynı olmalı,
 *  - Onay iptal edilmemiş olmalı ve istenen kapsamı içermeli,
 *  - Aynı sürüm için daha sonra verilmiş bir ret olmamalı.
 */
export async function findValidApproval(brandId: string, versionId: string, scope: string, db: Queryable = getPool()) {
  const v = await q1<OutputVersion & { current_version: number }>(
    `SELECT v.*, o.current_version FROM output_versions v JOIN outputs o ON o.id = v.output_id WHERE v.id = $1 AND v.brand_id = $2`,
    [versionId, brandId],
    db,
  );
  if (!v) return { ok: false as const, reason: "Sürüm bulunamadı." };
  if (v.version !== v.current_version) return { ok: false as const, reason: `Sürüm ${v.version} artık güncel değil (güncel: ${v.current_version}). Yeni sürüm onaylanmalı.` };
  if (contentHash(v.content) !== v.content_hash) return { ok: false as const, reason: "İçerik bütünlüğü doğrulanamadı." };
  const latest = await q1<Approval>(
    `SELECT * FROM approvals WHERE output_version_id = $1 AND brand_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [versionId, brandId],
    db,
  );
  if (!latest || latest.decision !== "approved") return { ok: false as const, reason: "Bu sürüm için geçerli onay yok." };
  if (latest.content_hash !== v.content_hash) return { ok: false as const, reason: "Onaylanan içerik ile mevcut içerik farklı." };
  if (!latest.scopes.includes(scope)) return { ok: false as const, reason: `Onay '${scope}' işlemini kapsamıyor.` };
  return { ok: true as const, approval: latest, version: v };
}

export async function revokeApproval(brandId: string, approvalId: string) {
  await q(`UPDATE approvals SET revoked_at = now() WHERE id = $1 AND brand_id = $2`, [approvalId, brandId]);
  await audit({ brandId, actor: "user", action: "approval.revoke", message: `Onay geri alındı (${approvalId.slice(0, 8)})` });
}

export async function pendingApprovals(brandId: string, db: Queryable = getPool()) {
  return q<Output & { version_id: string; version: number; is_demo: boolean; verdict: string | null; task_status: string | null }>(
    `SELECT o.*, v.id AS version_id, v.version, v.is_demo, v.qa_report->>'verdict' AS verdict, t.status AS task_status
     FROM outputs o
     JOIN output_versions v ON v.output_id = o.id AND v.version = o.current_version
     LEFT JOIN tasks t ON t.id = o.task_id
     WHERE o.brand_id = $1 AND o.kind NOT IN ('plan','project_report','qa_report')
       AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.output_version_id = v.id AND a.revoked_at IS NULL)
       AND (t.status IS NULL OR t.status IN ('approval_pending','completed'))
     ORDER BY (t.status = 'approval_pending') DESC NULLS LAST, o.updated_at DESC`,
    [brandId],
    db,
  );
}

