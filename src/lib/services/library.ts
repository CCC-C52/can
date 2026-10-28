import { q, q1, tx, type Queryable, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { getBrand } from "@/lib/services/brands";
import { LIBRARY_CHECKED_AT, LIBRARY_SEED } from "@/lib/pr-agency/library";

// PR bilgi kütüphanesi: yayımlanmış çerçeveler, doğrulanmış dış araştırma ve AI önerileri ayrı türlerdir.
// Her değişiklik geçmişe yazılır; aranabilir. AI önerisi hiçbir zaman "doğrulanmış" işaretlenemez.

export type LibraryKind = "framework" | "external_research" | "ai_recommendation";
export type LibraryEntry = {
  id: string; brand_id: string; slug: string; kind: LibraryKind; category: string; title: string; summary: string;
  application: string | null; source_title: string | null; source_url: string | null; source_ref: string | null;
  publisher: string | null; version: string | null; published_year: number | null;
  verification: "verified" | "partially_verified" | "needs_review"; verified_note: string | null; checked_at: string | null;
  created_by: string; created_at: string; updated_at: string;
};

export class LibraryError extends Error {}

const slugify = (s: string) => s.toLocaleLowerCase("en-US").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 70) || "entry";

/** Çerçeve kayıtlarını bir kez ekler; var olan (sahibin düzenlediği) kayıtlar değişmez. */
export async function seedLibrary(brandId: string, actor = "user", db: Queryable = getPool()) {
  if (!(await getBrand(brandId, db))) throw new LibraryError("Marka bulunamadı.");
  return tx(async (c) => {
    let created = 0;
    for (const e of LIBRARY_SEED) {
      const r = await q1<{ id: string }>(
        `INSERT INTO pr_library_entries (brand_id, slug, kind, category, title, summary, application, source_title, source_url, source_ref, publisher, version, published_year, verification, verified_note, checked_at, created_by)
         VALUES ($1,$2,'framework',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (brand_id, slug) DO NOTHING RETURNING id`,
        [brandId, e.slug, e.category, e.title, e.summary, e.application, e.sourceTitle, e.sourceUrl, e.sourceRef, e.publisher, e.version, e.publishedYear, e.verification, e.verifiedNote, LIBRARY_CHECKED_AT, `seed:${actor}`],
        c,
      );
      if (r) {
        await q(`INSERT INTO pr_library_revisions (entry_id, brand_id, changed_by, before, after) VALUES ($1,$2,$3,NULL,$4)`, [r.id, brandId, `seed:${actor}`, JSON.stringify(e)], c);
        created++;
      }
    }
    if (created) await audit({ brandId, actor, action: "library.seed", message: `PR bilgi kütüphanesine ${created} çerçeve eklendi` }, c);
    return { created };
  });
}

export async function searchLibrary(brandId: string, opts: { q?: string | null; kind?: LibraryKind | null; limit?: number } = {}, db: Queryable = getPool()) {
  const term = opts.q?.trim().slice(0, 100) || null;
  return q<LibraryEntry>(
    `SELECT * FROM pr_library_entries
     WHERE brand_id = $1 AND ($2::text IS NULL OR kind = $2)
       AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%' OR summary ILIKE '%' || $3 || '%' OR category ILIKE '%' || $3 || '%'
            OR COALESCE(application,'') ILIKE '%' || $3 || '%' OR COALESCE(source_title,'') ILIKE '%' || $3 || '%')
     ORDER BY array_position(ARRAY['framework','external_research','ai_recommendation']::text[], kind), category, title
     LIMIT $4`,
    [brandId, opts.kind ?? null, term?.replace(/[%_\\]/g, (m) => `\\${m}`) ?? null, Math.min(200, opts.limit ?? 100)],
    db,
  );
}

export async function libraryCounts(brandId: string, db: Queryable = getPool()) {
  const r = await q<{ kind: LibraryKind; n: number }>(`SELECT kind, COUNT(*)::int AS n FROM pr_library_entries WHERE brand_id = $1 GROUP BY kind`, [brandId], db);
  const out: Record<LibraryKind, number> = { framework: 0, external_research: 0, ai_recommendation: 0 };
  for (const x of r) out[x.kind] = x.n;
  return out;
}

export async function libraryHistory(brandId: string, limit = 20, db: Queryable = getPool()) {
  return q<{ id: string; entry_id: string; title: string; changed_by: string; created_at: string; created: boolean }>(
    `SELECT r.id, r.entry_id, e.title, r.changed_by, r.created_at, (r.before IS NULL) AS created
     FROM pr_library_revisions r JOIN pr_library_entries e ON e.id = r.entry_id WHERE r.brand_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [brandId, limit],
    db,
  );
}

export type LibraryInput = { kind: LibraryKind; category: string; title: string; summary: string; application?: string | null; sourceTitle?: string | null; sourceUrl?: string | null; publisher?: string | null; publishedYear?: number | null };

function validate(i: LibraryInput) {
  if (!["framework", "external_research", "ai_recommendation"].includes(i.kind)) throw new LibraryError("Geçersiz tür.");
  if (i.title.trim().length < 2 || i.summary.trim().length < 10 || i.category.trim().length < 2) throw new LibraryError("Başlık, kategori ve en az 10 karakterlik özet gerekli.");
  if (i.sourceUrl && !/^https:\/\/[^\s]+$/.test(i.sourceUrl)) throw new LibraryError("Kaynak adresi https:// ile başlamalı.");
  // Dış araştırma ve çerçeve kaynaksız olamaz; AI önerisi kaynaksız olabilir ama asla doğrulanmış sayılmaz
  if (i.kind !== "ai_recommendation" && !i.sourceUrl && !i.sourceTitle?.trim()) throw new LibraryError("Çerçeve ve dış araştırma için kaynak (başlık veya adres) gerekli.");
}

export async function addLibraryEntry(brandId: string, i: LibraryInput, actor = "user") {
  validate(i);
  return tx(async (c) => {
    const base = slugify(i.title);
    let slug = base, n = 1;
    while (await q1(`SELECT 1 FROM pr_library_entries WHERE brand_id = $1 AND slug = $2`, [brandId, slug], c)) slug = `${base}-${++n}`;
    const row = await q1<LibraryEntry>(
      `INSERT INTO pr_library_entries (brand_id, slug, kind, category, title, summary, application, source_title, source_url, publisher, published_year, verification, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'needs_review',$12) RETURNING *`,
      [brandId, slug, i.kind, i.category.trim().slice(0, 80), i.title.trim().slice(0, 300), i.summary.trim().slice(0, 4000), i.application?.trim().slice(0, 4000) || null, i.sourceTitle?.trim().slice(0, 500) || null, i.sourceUrl || null, i.publisher?.trim().slice(0, 300) || null, i.publishedYear ?? null, actor],
      c,
    );
    await q(`INSERT INTO pr_library_revisions (entry_id, brand_id, changed_by, before, after) VALUES ($1,$2,$3,NULL,$4)`, [row!.id, brandId, actor, JSON.stringify(i)], c);
    await audit({ brandId, actor, action: "library.add", message: `Bilgi kütüphanesine eklendi (${i.kind}): ${i.title}` }, c);
    return row!;
  });
}

/** Doğrulama durumunu değiştirir. AI önerisi "verified" olamaz; "verified" için kaynak adresi ve not zorunlu. */
export async function setLibraryVerification(brandId: string, id: string, verification: LibraryEntry["verification"], note: string, actor = "user") {
  return tx(async (c) => {
    const cur = await q1<LibraryEntry>(`SELECT * FROM pr_library_entries WHERE id = $1 AND brand_id = $2 FOR UPDATE`, [id, brandId], c);
    if (!cur) throw new LibraryError("Kayıt bulunamadı.");
    if (!["verified", "partially_verified", "needs_review"].includes(verification)) throw new LibraryError("Geçersiz doğrulama durumu.");
    if (cur.kind === "ai_recommendation" && verification !== "needs_review") throw new LibraryError("AI önerisi doğrulanmış kaynak olarak işaretlenemez; önce kaynaklı dış araştırma olarak ekleyin.");
    if (verification === "verified" && (!cur.source_url || note.trim().length < 5)) throw new LibraryError("Doğrulamak için kaynak adresi ve doğrulama notu gerekli.");
    const today = new Date().toISOString().slice(0, 10);
    await q(`UPDATE pr_library_entries SET verification = $3, verified_note = $4, checked_at = $5, updated_at = now() WHERE id = $1 AND brand_id = $2`, [id, brandId, verification, note.trim().slice(0, 1000) || null, today], c);
    await q(`INSERT INTO pr_library_revisions (entry_id, brand_id, changed_by, before, after) VALUES ($1,$2,$3,$4,$5)`,
      [id, brandId, actor, JSON.stringify({ verification: cur.verification, verified_note: cur.verified_note }), JSON.stringify({ verification, verified_note: note })], c);
    await audit({ brandId, actor, action: "library.verify", message: `${cur.title}: ${cur.verification} → ${verification}` }, c);
  });
}
