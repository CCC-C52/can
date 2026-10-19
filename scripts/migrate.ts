import "./load-env";
import { runMigrations } from "@/lib/db/migrate";
import { closePool } from "@/lib/db/pool";

const done = await runMigrations();
console.log(done.length ? `Uygulanan geçişler: ${done.join(", ")}` : "Veritabanı güncel.");
await closePool();
