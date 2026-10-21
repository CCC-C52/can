import "./load-env";
import { config } from "@/lib/config";
import { q1, closePool } from "@/lib/db/pool";
import { runAcceptance } from "./acceptance/workflow";

// Kabul iş akışını (24 adım) GERÇEK bir markaya karşı çalıştırır — yalnızca sahibin yetkilendirdiği KOPYA ortamda.
//   ACCEPTANCE_CONFIRM_COPY=yes npm run acceptance -- --brand fribee
// Mevcut kayıtları değiştirmez; yeni bir proje, çıktı sürümleri, kararlar ve türetilmiş dosyalar ekler.
// APP_MODE=production iken çalışmaz. Metin modeli bağlı değilse DEMO şablonları kullanılır ve bu açıkça raporlanır.

async function main() {
  const i = process.argv.indexOf("--brand");
  const slug = i > 0 ? process.argv[i + 1] : undefined;
  if (!slug) throw new Error("Kullanım: npm run acceptance -- --brand <marka-slug>");
  if (config.appMode === "production") throw new Error("APP_MODE=production: kabul akışı canlı veritabanında çalıştırılmaz. Yetkili bir kopya ortam kullanın.");
  if (process.env.ACCEPTANCE_CONFIRM_COPY !== "yes") throw new Error("Bu veritabanının yetkili bir KOPYA olduğunu ACCEPTANCE_CONFIRM_COPY=yes ile onaylayın.");
  const b = await q1<{ id: string; name: string }>(`SELECT id, name FROM brands WHERE slug = $1`, [slug]);
  if (!b) throw new Error(`Marka bulunamadı: ${slug}`);
  console.log(`Kabul akışı: ${b.name}\n`);
  const results = await runAcceptance({ brandId: b.id, log: (r) => console.log(`${r.status.padEnd(4)} ${String(r.step).padStart(2)}. ${r.name} — ${r.detail}`) });
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${results.filter((r) => r.status === "PASS").length}/24 geçti${failed ? `, ${failed} başarısız` : ""}`);
  await closePool();
  process.exit(failed ? 1 : 0);
}
main().catch(async (e) => {
  console.error((e as Error).message);
  await closePool().catch(() => {});
  process.exit(1);
});
