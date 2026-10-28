// Brand Brain CANLI doğrulama (sahibin onayladığı gerçek Drive klasörüyle). Ücretli çağrı YAPMAZ: yalnızca dizin
// durumunu ve rol filtreli aramayı ölçer (gömme açık değilse tam metin araması). Kullanım (canlı/staging veritabanı):
//   BRAIN_LIVE_BRAND="FriBee" npx tsx --tsconfig tsconfig.json scripts/brain-live-check.ts
// Çıktı: dört koleksiyon için bulunan kaynak dosyalar, doğrulama etiketleri, eksikler, gecikme ve kapsama.
// Kayıtlar "dashboard" amaçlı erişim olarak kb_retrievals'a yazılır (ajan başarı oranını etkilemez).
import "./load-env";
import { q1, closePool } from "@/lib/db/pool";
import { brainStatus } from "@/lib/brain/status";
import { searchBrain } from "@/lib/brain/retrieval";
import { listConflicts } from "@/lib/brain/claims";

const COLLECTIONS: [string, string][] = [["space_alien", "Space Alien"], ["music", "Music"], ["anime", "Anime"], ["save_the_bee", "Save the Bee"]];

async function main() {
  const name = process.env.BRAIN_LIVE_BRAND;
  if (!name) throw new Error("BRAIN_LIVE_BRAND tanımlı değil (ör. FriBee).");
  const brand = await q1<{ id: string; name: string }>(`SELECT id, name FROM brands WHERE name = $1 AND is_sample = false`, [name]);
  if (!brand) throw new Error(`Marka bulunamadı: ${name}`);
  const st = await brainStatus(brand.id);
  if (!st.drive?.connected) console.warn(`UYARI: Drive bağlantısı "${st.drive?.status ?? "yok"}"; sonuçlar son eşitlemeye göredir.`);
  const report = [];
  for (const [key, label] of COLLECTIONS) {
    const r = await searchBrain({ brandId: brand.id, role: "pr", query: `${label} collection story koleksiyon hikaye`, limit: 5, collection: key as never, record: { purpose: "test" } });
    report.push({
      collection: label, mode: r.mode, latency_ms: r.latency_ms, withheld: r.withheld,
      sources: r.hits.map((h) => ({ label: h.label, file: h.path ?? h.name, section: h.section, verification: h.verification })),
      missing: r.hits.length ? null : `${label} için arşivde kaynak bulunamadı (uydurulmadı)`,
    });
  }
  const refs = await q1<{ verified: number; uncertain: number }>(
    `SELECT count(*) FILTER (WHERE status = 'verified')::int AS verified, count(*) FILTER (WHERE status = 'uncertain')::int AS uncertain FROM drive_references WHERE brand_id = $1`, [brand.id]);
  console.log(JSON.stringify({
    measured_at: new Date().toISOString(), brand: brand.name,
    coverage: { files: st.archive.files, gigabytes: Math.round((st.archive.bytes / 1e9) * 100) / 100, content_extracted: st.documents.contentExtracted, metadata_only: st.documents.metadataOnly, failed: st.documents.failed + st.documents.dead, coverage_pct: st.documents.coverage, semantic_coverage_pct: st.chunks.semanticCoverage },
    collections: report,
    product_references: refs,
    conflicts: (await listConflicts(brand.id)).map((c) => ({ entity: c.entity_name, attribute: c.attribute, values: c.values.map((v) => `${v.value} (${v.status})`), reason: c.reason })),
  }, null, 2));
}

main().catch((e) => { console.error(`CANLI DOĞRULAMA BAŞARISIZ: ${(e as Error).message}`); process.exitCode = 1; }).finally(() => closePool());
