import "./load-env";
import { checkIntegrity } from "@/lib/db/check";
import { closePool } from "@/lib/db/pool";

const issues = await checkIntegrity();
if (!issues.length) console.log("Bütünlük denetimi: sorun bulunmadı.");
for (const i of issues) console.log(`[${i.check}] ${i.description}: ${i.count} kayıt (örnek: ${i.sample.join(", ")})`);
console.log("Not: Bu araç hiçbir kaydı değiştirmez. Düzeltme, sahip onayıyla ayrı bir adımda yapılır.");
await closePool();
process.exit(issues.length ? 2 : 0);
