import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { getBrand, listBrands } from "@/lib/services/brands";
import { buildBrandContext } from "@/lib/agents/context";
import { getMedia, type MediaAsset } from "@/lib/services/media";
import { requestAnalysis, runAnalysisQueueOnce, latestAnalysis } from "@/lib/media-analysis";
import { probeVideo } from "@/lib/media-analysis/video";
import { Engine } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks, requestRegeneration } from "@/lib/orchestrator/projects";
import { decide, listApprovals, listOutputs, listVersions, getCurrentVersion, pendingApprovals, getOutput } from "@/lib/services/outputs";
import { getStorage } from "@/lib/storage";

// FriBee kabul iş akışının 24 adımı (Faz 17). Aynı kod iki yerde çalışır:
//   1) otomatik test: yalıtılmış fikstür markası (tests/acceptance.test.ts)
//   2) sahibin yetkilendirdiği KOPYA veritabanı: npm run acceptance -- --brand <slug>
// Mevcut kayıtlar DEĞİŞTİRİLMEZ: yalnızca yeni bir proje, çıktılar, kararlar ve türetilmiş dosyalar eklenir.

export type StepResult = { step: number; name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };

export async function runAcceptance(opts: {
  brandId: string;
  otherBrandId?: string;            // 24. adım için; verilmezse başka bir marka aranır
  objective?: string;
  workerId?: string;
  log?: (r: StepResult) => void;
}): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const ctx: Record<string, any> = {};
  const step = async (n: number, name: string, fn: () => Promise<string>) => {
    let r: StepResult;
    try {
      r = { step: n, name, status: "PASS", detail: await fn() };
    } catch (err) {
      r = { step: n, name, status: (err as Error).name === "Skip" ? "SKIP" : "FAIL", detail: (err as Error).message };
    }
    results.push(r);
    opts.log?.(r);
  };
  const need = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
  const engine = new Engine(opts.workerId ?? `acceptance-${process.pid}`);
  const drive = async (projectId: string, max = 400) => {
    for (let i = 0; i < max; i++) {
      await q(`UPDATE tasks SET next_attempt_at = now() WHERE project_id = $1 AND status = 'ready' AND next_attempt_at > now()`, [projectId]);
      const n = await engine.tick();
      await engine.waitInflight();
      const active = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE project_id = $1 AND status IN ('planned','ready','running','review_pending')`, [projectId]);
      if (!n && !active!.n) return;
    }
    throw new Error("Proje görevleri süre içinde bitmedi");
  };
  const analyze = async (asset: MediaAsset) => {
    await requestAnalysis(asset.brand_id, asset.id);
    for (let i = 0; i < 30; i++) {
      const a = await latestAnalysis(asset.brand_id, asset.id);
      if (a?.status === "completed" || a?.status === "failed") return a;
      await runAnalysisQueueOnce(opts.workerId ?? "acceptance");
    }
    return latestAnalysis(asset.brand_id, asset.id);
  };

  await step(1, "Markayı seç", async () => {
    ctx.brand = await getBrand(opts.brandId);
    need(ctx.brand, "Marka bulunamadı");
    return `${ctx.brand.name} (${ctx.brand.content_language})`;
  });
  await step(2, "Marka bağlamını al", async () => {
    const b = await buildBrandContext(opts.brandId, undefined, { agent: "manager" });
    need(b.brand.name === ctx.brand.name, "Bağlam başka markaya ait");
    ctx.products = b.products;
    return `${b.products.length} ürün, ${b.media.length} medya kaydı bağlamda`;
  });
  await step(3, "Mevcut ürün görselini doğrula", async () => {
    ctx.photo = await q1<MediaAsset>(`SELECT * FROM media_assets WHERE brand_id = $1 AND kind = 'photo' AND origin = 'real_photo' ORDER BY created_at LIMIT 1`, [opts.brandId]);
    need(ctx.photo, "Markanın gerçek ürün fotoğrafı yok");
    const buf = await getStorage().get(ctx.photo.storage_key);
    const m = await sharp(buf).metadata();
    need(m.width && m.height, "Görsel çözülemedi");
    return `${ctx.photo.filename} · ${m.width}x${m.height} ${m.format} · ${buf.length} bayt`;
  });
  await step(4, "Mevcut videoyu doğrula", async () => {
    ctx.video = await q1<MediaAsset>(`SELECT * FROM media_assets WHERE brand_id = $1 AND kind = 'video' AND origin = 'real_video' ORDER BY created_at LIMIT 1`, [opts.brandId]);
    need(ctx.video, "Markanın gerçek videosu yok");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acc-"));
    try {
      const f = path.join(dir, "v");
      await getStorage().downloadToFile(ctx.video.storage_key, f);
      const p = await probeVideo(f);
      need(p.duration > 0, "Video süresi okunamadı");
      return `${ctx.video.filename} · ${p.display_width}x${p.display_height} · ${p.duration} sn · ${p.video_codec}`;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  await step(5, "Görsel piksellerini analiz et", async () => {
    const a = await analyze(ctx.photo);
    need(a?.status === "completed", `Analiz: ${a?.status} ${a?.error ?? ""}`);
    const l = a!.result.local;
    need(l.width > 0 && l.dominant_colors?.length, "Piksel analizi eksik");
    return `${l.width}x${l.height} · baskın: ${l.dominant_colors.slice(0, 3).map((c: any) => `${c.name} %${Math.round(c.share * 100)}`).join(", ")} · netlik ${Math.round(l.sharpness)}${a!.result.vision ? " · görsel model analizi var" : " · görsel model yok (yerel analiz)"}`;
  });
  await step(6, "Video karelerini çıkar ve analiz et", async () => {
    const a = await analyze(ctx.video);
    need(a?.status === "completed", `Analiz: ${a?.status} ${a?.error ?? ""}`);
    const keys: string[] = a!.result.frame_keys ?? [];
    need(keys.length > 0, "Kare çıkarılmadı");
    for (const k of keys) await sharp(await getStorage().get(k)).metadata();
    return `${keys.length} kare · ${a!.result.local.scenes.length} sahne · hareket: ${a!.result.local.motion.level}`;
  });
  await step(7, "Yöneticiye pazarlama hedefi gönder", async () => {
    const objective = opts.objective ?? `${ctx.products?.[0]?.title ?? "Öne çıkan ürün"} için lansman: pazarlama stratejisi ve metinleri, ürün sayfası önerisi, görseller (carousel ve story dahil), kısa video ve 7 günlük sosyal medya planı.`;
    const { project } = await submitInstruction({ brandId: opts.brandId, instruction: objective, idempotencyKey: `acceptance-${Date.now()}` });
    ctx.projectId = project.id;
    await drive(project.id);
    return `proje ${project.id}`;
  });
  await step(8, "Görev dağıtımını doğrula", async () => {
    ctx.tasks = await listTasks(opts.brandId, { projectId: ctx.projectId });
    const agents = new Set(ctx.tasks.filter((t: any) => t.kind === "work").map((t: any) => t.agent));
    need(agents.size >= 3, `Yalnızca ${agents.size} uzman`);
    return `${ctx.tasks.length} görev · uzmanlar: ${[...agents].join(", ")} · durumlar: ${ctx.tasks.map((t: any) => `${t.key}=${t.status}`).join(" ")}`;
  });
  await step(9, "Yetkili çıktı paylaşımını doğrula", async () => {
    const deps = await q<{ down: string; up: string }>(
      `SELECT d.agent AS down, u.agent AS up FROM task_dependencies x JOIN tasks d ON d.id = x.task_id JOIN tasks u ON u.id = x.depends_on_task_id
       WHERE d.project_id = $1 AND d.kind = 'work' AND u.kind = 'work'`, [ctx.projectId]);
    need(deps.length > 0, "Uzmanlar arası bağımlılık yok");
    const perm = ctx.tasks.filter((t: any) => t.failure_class === "permission");
    need(!perm.length, `Yetki hatası: ${perm.map((t: any) => t.key).join(", ")}`);
    return deps.map((d) => `${d.up}→${d.down}`).join(", ");
  });
  const content = async (kind: string) => {
    const o = (await listOutputs(opts.brandId, { projectId: ctx.projectId })).find((x) => x.kind === kind);
    need(o, `${kind} çıktısı yok`);
    return { output: o!, version: (await getCurrentVersion(opts.brandId, o!.id))! };
  };
  await step(10, "Pazarlama metni üret", async () => {
    const { version } = await content("strategy");
    const c = version.content;
    need(c.key_messages?.length && c.positioning, "Mesaj/konumlandırma yok");
    return `${c.key_messages.length} ana mesaj, ${c.ad_ideas?.length ?? 0} reklam fikri${version.is_demo ? " (DEMO şablon)" : ""}`;
  });
  await step(11, "Üç Instagram konsepti üret", async () => {
    const { version } = await content("social_package");
    ctx.social = version;
    const ig = version.content.posts.filter((p: any) => p.platform === "instagram");
    need(ig.length >= 3, `${ig.length} Instagram gönderisi`);
    return ig.slice(0, 3).map((p: any) => `${p.id}/${p.format}`).join(", ");
  });
  await step(12, "İki Reels konsepti üret", async () => {
    const r = ctx.social?.content?.reels_ideas ?? [];
    need(r.length >= 2, `${r.length} Reels fikri`);
    return r.slice(0, 2).map((x: any) => x.title).join(" | ");
  });
  await step(13, "Yedi günlük organik plan üret", async () => {
    const cal = ctx.social?.content?.calendar_7d ?? [];
    need(cal.length === 7 && new Set(cal.map((d: any) => d.day)).size === 7, `${cal.length} gün`);
    return cal.map((d: any) => `${d.day}:${d.platform}`).join(" ");
  });
  await step(14, "En az bir gerçek görsel derlemesi oluştur", async () => {
    const rows = await q<MediaAsset>(`SELECT * FROM media_assets WHERE brand_id = $1 AND project_id = $2 AND origin = 'composed'`, [opts.brandId, ctx.projectId]);
    need(rows.length, "Derleme yok");
    const sizes = [];
    for (const r of rows) {
      const m = await sharp(await getStorage().get(r.storage_key)).metadata();
      sizes.push(`${m.width}x${m.height}`);
    }
    ctx.composed = rows;
    return `${rows.length} dosya: ${sizes.join(", ")}`;
  });
  await step(15, "Oynatılabilir kurgulanmış MP4 oluştur", async () => {
    const v = await q1<MediaAsset>(`SELECT * FROM media_assets WHERE brand_id = $1 AND project_id = $2 AND kind = 'video' AND generation_method = 'ffmpeg_edit'`, [opts.brandId, ctx.projectId]);
    need(v, "Kurgulanmış video yok (video görevi durumu: " + ctx.tasks.filter((t: any) => t.agent === "video").map((t: any) => `${t.key}=${t.status} ${t.error ?? ""}`).join("; ") + ")");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acc-"));
    try {
      const f = path.join(dir, "o.mp4");
      await getStorage().downloadToFile(v!.storage_key, f);
      const p = await probeVideo(f);
      need(p.video_codec === "h264" && p.duration > 0.5, `codec ${p.video_codec} süre ${p.duration}`);
      ctx.edited = v;
      return `${v!.filename} · ${p.width}x${p.height} · ${p.duration} sn · h264 · ${v!.mime_type}`;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  await step(16, "Onay öğeleri oluştur", async () => {
    const pend = (await pendingApprovals(opts.brandId)).filter((p) => p.project_id === ctx.projectId);
    need(pend.length, "Onay bekleyen yok");
    return pend.map((p) => `${p.kind} v${p.version}`).join(", ");
  });
  await step(17, "Bir çıktıyı reddet", async () => {
    const { output, version } = await content("social_package");
    ctx.rejectOutput = output; ctx.rejectedVersion = version;
    await decide(opts.brandId, version.id, "rejected", { note: "Kabul testi: CTA daha net olsun", scopes: [] });
    return `${output.title} v${version.version} reddedildi`;
  });
  await step(18, "Revizyon iste", async () => {
    await requestRegeneration(opts.brandId, ctx.rejectOutput.id, "Kabul testi: CTA daha net olsun");
    await drive(ctx.projectId);
    const v = await getCurrentVersion(opts.brandId, ctx.rejectOutput.id);
    need(v && v.version > ctx.rejectedVersion.version, "Yeni sürüm oluşmadı");
    ctx.revised = v;
    const t = await q1<{ feedback: string | null }>(`SELECT feedback FROM tasks WHERE id = $1`, [ctx.rejectOutput.task_id]);
    return `v${v!.version} üretildi · geri bildirim: ${t?.feedback ?? "—"}`;
  });
  await step(19, "Revize çıktıyı onayla", async () => {
    const a = await decide(opts.brandId, ctx.revised.id, "approved", { scopes: ["content"] });
    need(a.content_hash === ctx.revised.content_hash, "Onay içerik özetine bağlı değil");
    return `v${ctx.revised.version} onaylandı (özet ${a.content_hash.slice(0, 10)})`;
  });
  await step(20, "Onay geçmişini doğrula", async () => {
    const hist = await listApprovals(opts.brandId, ctx.rejectOutput.id);
    need(hist.some((h) => h.output_version_id === ctx.rejectedVersion.id && h.decision === "rejected"), "Ret kaydı yok");
    need(hist.some((h) => h.output_version_id === ctx.revised.id && h.decision === "approved"), "Onay kaydı yok");
    const vs = await listVersions(opts.brandId, ctx.rejectOutput.id);
    need(vs.length >= 2, "Eski sürüm silinmiş");
    let immutable = false;
    try { await q(`UPDATE approvals SET decision = 'approved' WHERE output_version_id = $1`, [ctx.rejectedVersion.id]); } catch { immutable = true; }
    need(immutable, "Onay kaydı değiştirilebildi");
    return `${hist.length} karar · ${vs.length} sürüm · kayıtlar değiştirilemez`;
  });
  await step(21, "İndirilebilir çıktı dosyalarını doğrula", async () => {
    const files = [...(ctx.composed ?? []), ...(ctx.edited ? [ctx.edited] : [])] as MediaAsset[];
    need(files.length, "Dosya yok");
    for (const f of files) {
      const s = await getStorage().stream(f.storage_key, { start: 0, end: 15 });
      const head = Buffer.from(await new Response(s).arrayBuffer());
      const okMagic = f.mime_type === "video/mp4" ? head.subarray(4, 8).toString() === "ftyp" : f.mime_type === "image/png" ? head[0] === 0x89 : head[0] === 0xff && head[1] === 0xd8;
      need(okMagic, `${f.filename}: içerik türü ${f.mime_type} ile uyuşmuyor`);
      need(Number(f.size_bytes) > 0, `${f.filename}: boş`);
    }
    return `${files.length} dosya akış ile okunabilir, tür imzaları doğru`;
  });
  await step(22, "Otomatik yayın olmadığını doğrula", async () => {
    const ext = await q<{ status: string }>(`SELECT a.status FROM external_actions a JOIN output_versions v ON v.id = a.output_version_id JOIN outputs o ON o.id = v.output_id WHERE o.project_id = $1`, [ctx.projectId]);
    need(!ext.length, `${ext.length} dış işlem kaydı var`);
    const cal = await q<{ status: string }>(`SELECT c.status FROM calendar_entries c JOIN outputs o ON o.id = c.output_id WHERE o.project_id = $1`, [ctx.projectId]);
    need(cal.every((c) => c.status !== "published"), "Yayınlanmış takvim girdisi var");
    return `dış işlem: 0 · takvim girdileri: ${cal.length} (hiçbiri yayınlanmadı)`;
  });
  await step(23, "Kullanım ve maliyet takibini doğrula", async () => {
    const c = await q1<{ n: number; est: number | null; act: number | null; unknown: number }>(
      `SELECT COUNT(*)::int AS n, SUM(amount_usd) FILTER (WHERE kind='estimated')::float AS est, SUM(amount_usd) FILTER (WHERE kind='actual')::float AS act,
         COUNT(*) FILTER (WHERE amount_usd IS NULL)::int AS unknown FROM cost_entries WHERE project_id = $1`, [ctx.projectId]);
    need(c!.n > 0, "Maliyet kaydı yok");
    const calls = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM task_attempts a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = $1`, [ctx.projectId]);
    return `${c!.n} maliyet kaydı · tahmini $${(c!.est ?? 0).toFixed(4)} · gerçekleşen $${(c!.act ?? 0).toFixed(4)}${c!.unknown ? ` · ${c!.unknown} bilinmiyor` : ""} · ${calls!.n} görev denemesi`;
  });
  await step(24, "Markalar arası yalıtımı doğrula", async () => {
    const other = opts.otherBrandId ?? (await listBrands()).find((b) => b.id !== opts.brandId)?.id;
    if (!other) throw Object.assign(new Error("Karşılaştırılacak ikinci marka yok"), { name: "Skip" });
    need(!(await getMedia(other, ctx.photo.id)), "Diğer marka fotoğrafa erişti");
    need(!(await getOutput(other, ctx.rejectOutput.id)), "Diğer marka çıktıya erişti");
    need(!(await latestAnalysis(other, ctx.video.id)), "Diğer marka analize erişti");
    const octx = await buildBrandContext(other, undefined, { agent: "manager" });
    const leaked = JSON.stringify(octx).includes(ctx.photo.id) || JSON.stringify(octx).includes(opts.brandId);
    need(!leaked, "Diğer markanın ajan bağlamına bu markanın verisi sızdı");
    let blocked = false;
    try { await decide(other, ctx.revised.id, "approved"); } catch { blocked = true; }
    need(blocked, "Diğer marka bu markanın sürümünü onaylayabildi");
    return "medya, çıktı, analiz, ajan bağlamı ve onay işlemi marka dışından erişilemez";
  });
  return results;
}
