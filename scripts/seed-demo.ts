import "./load-env";
import { runMigrations } from "@/lib/db/migrate";
import { closePool } from "@/lib/db/pool";
import { seedSampleBrand } from "@/lib/services/sample";

await runMigrations();
const r = await seedSampleBrand();
console.log(r.created ? `Örnek (DEMO) marka oluşturuldu: ${r.brandId}` : `Örnek marka zaten var: ${r.brandId}`);
await closePool();
