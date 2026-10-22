// Geçiş güvenlik denetimi (CI ve yerel): npm run migrations:check
// Çıkış kodu 0 = politika uygun. JSON özet için: npm run migrations:check -- --json
import path from "node:path";
import { checkPolicy } from "@/lib/db/migration-safety";

const r = checkPolicy(path.resolve(process.cwd(), "migrations"));
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(r, null, 2));
} else {
  for (const m of r.migrations) {
    console.log(`${m.name}  sınıf=${m.class}  politika=${m.policy}${m.requiresAuthorization ? "  ilk-canlı-uygulama=SAHİP ONAYI" : ""}${m.autoApprovable ? "  otomatik=evet" : ""}`);
    // Onaylı (baseline/reviewed) dosyalarda bulgular yalnızca sayı olarak; ayrıntı için --verbose
    const verbose = process.argv.includes("--verbose") || (m.policy !== "baseline" && m.policy !== "reviewed");
    if (verbose) for (const f of m.findings) console.log(`    ${f.severity}: ${f.rule} — ${f.statement}`);
    else if (m.findings.length) console.log(`    (${m.findings.length} inceleme bulgusu; politika: ${m.policy}, insan incelemesinden geçmiş)`);
  }
  for (const e of r.errors) console.error(`HATA  ${e}`);
  console.log(r.ok ? "\nGeçiş politikası: UYGUN" : "\nGeçiş politikası: UYGUN DEĞİL");
}
process.exit(r.ok ? 0 : 1);
