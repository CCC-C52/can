// Brand Brain başlangıç ölçümü — SALT OKUNUR (yalnızca SELECT). Canlı ortamda Render kabuğundan:
//   npx tsx --tsconfig tsconfig.json scripts/brain-baseline.ts
// Çıktı: marka başına Drive kapsamı, içerik çıkarma durumu, bekleyen inceleme, hata ve erişim başarısı (JSON).
// Gizli değer veya belge içeriği yazdırılmaz.
import "./load-env";
import { q, closePool } from "@/lib/db/pool";
import { brainStatus } from "@/lib/brain/status";

async function main() {
  const brands = await q<{ id: string; name: string }>(`SELECT b.id, b.name FROM brands b WHERE b.is_sample = false ORDER BY b.created_at`);
  const out = [];
  for (const b of brands) {
    const s = await brainStatus(b.id).catch((e) => ({ error: (e as Error).message }));
    if ("error" in s) { out.push({ brand: b.name, error: s.error }); continue; }
    out.push({
      brand: b.name,
      drive: s.drive && { status: s.drive.status, folder: s.drive.folder_name, last_success_at: s.drive.last_success_at, full_scan_completed_at: s.drive.full_scan_completed_at, consecutive_failures: s.drive.consecutive_failures },
      archive: { files: s.archive.files, gigabytes: Math.round((s.archive.bytes / 1e9) * 100) / 100, folders: s.archive.folders, removed: s.archive.removed, pending_checksum: s.archive.pendingChecksum, malformed: s.archive.malformed, by_type: s.archive.families },
      brain: { tracked: s.documents.tracked, by_status: s.documents.byStatus, content_extracted: s.documents.contentExtracted, metadata_only: s.documents.metadataOnly, duplicates: s.documents.duplicates, coverage_pct: s.documents.coverage },
      chunks: s.chunks,
      reviews: s.reviews,
      queue: s.queue,
      retrieval_30d: s.retrieval,
      semantic: { enabled: s.semantic.enabled, provider: s.semantic.provider, pgvector: s.semantic.pgvector, backlog: s.semantic.backlog },
      failed_files: s.errors.length,
    });
  }
  console.log(JSON.stringify({ measured_at: new Date().toISOString(), brands: out }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closePool());
