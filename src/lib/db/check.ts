import { q, type Queryable, getPool } from "./pool";

// Yıkıcı olmayan veri bütünlüğü denetimi. Hiçbir satırı değiştirmez; yalnızca rapor üretir.
// Çalıştırma: npm run db:check

export type IntegrityIssue = { check: string; description: string; count: number; sample: string[] };

const CHECKS: { check: string; description: string; sql: string }[] = [
  { check: "task_output_missing", description: "Görevin output_id değeri var olmayan bir çıktıyı gösteriyor", sql: `SELECT t.id FROM tasks t LEFT JOIN outputs o ON o.id = t.output_id WHERE t.output_id IS NOT NULL AND o.id IS NULL` },
  { check: "task_output_brand_mismatch", description: "Görev ile çıktısı farklı markalara ait", sql: `SELECT t.id FROM tasks t JOIN outputs o ON o.id = t.output_id WHERE o.brand_id <> t.brand_id` },
  { check: "output_current_version_missing", description: "Çıktının güncel sürüm satırı yok", sql: `SELECT o.id FROM outputs o WHERE o.current_version > 0 AND NOT EXISTS (SELECT 1 FROM output_versions v WHERE v.output_id = o.id AND v.version = o.current_version)` },
  { check: "dependency_cross_project", description: "Görev bağımlılığı başka proje veya markaya işaret ediyor", sql: `SELECT d.task_id FROM task_dependencies d JOIN tasks a ON a.id = d.task_id JOIN tasks b ON b.id = d.depends_on_task_id WHERE a.project_id <> b.project_id OR a.brand_id <> b.brand_id` },
  { check: "approval_version_mismatch", description: "Onayın sürümü belirtilen çıktıya ait değil", sql: `SELECT a.id FROM approvals a JOIN output_versions v ON v.id = a.output_version_id WHERE v.output_id <> a.output_id OR v.brand_id <> a.brand_id` },
  { check: "media_parent_cross_brand", description: "Türev dosyanın kaynağı başka markaya ait", sql: `SELECT m.id FROM media_assets m JOIN media_assets p ON p.id = m.parent_asset_id WHERE p.brand_id <> m.brand_id` },
  { check: "lineage_cross_brand", description: "Kaynak-türev ilişkisi markalar arası", sql: `SELECT l.derived_asset_id FROM media_lineage l JOIN media_assets a ON a.id = l.derived_asset_id JOIN media_assets b ON b.id = l.source_asset_id WHERE a.brand_id <> b.brand_id` },
  { check: "cost_brand_mismatch", description: "Maliyet kaydının markası görevin markasından farklı", sql: `SELECT c.id FROM cost_entries c JOIN tasks t ON t.id = c.task_id WHERE c.brand_id IS DISTINCT FROM t.brand_id` },
  { check: "running_task_stale_lease", description: "Kiralaması 10 dakikadan uzun süre önce dolmuş 'çalışıyor' görev", sql: `SELECT id FROM tasks WHERE status = 'running' AND lease_expires_at < now() - interval '10 minutes'` },
  { check: "analysis_cross_brand", description: "Medya analizi başka markanın dosyasına bağlı", sql: `SELECT a.id FROM media_analyses a JOIN media_assets m ON m.id = a.asset_id WHERE m.brand_id <> a.brand_id` },
  { check: "provider_job_without_result", description: "Başarılı görünen sağlayıcı işinin kayıtlı dosyası yok", sql: `SELECT id FROM provider_jobs WHERE status = 'succeeded' AND result_asset_id IS NULL` },
];

export async function checkIntegrity(db: Queryable = getPool()): Promise<IntegrityIssue[]> {
  const out: IntegrityIssue[] = [];
  for (const c of CHECKS) {
    const rows = await q<{ id: string; task_id?: string; derived_asset_id?: string }>(c.sql, [], db);
    if (rows.length) out.push({ check: c.check, description: c.description, count: rows.length, sample: rows.slice(0, 5).map((r) => String(Object.values(r)[0])) });
  }
  return out;
}
