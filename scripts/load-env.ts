// tsx ile çalışan betikler için .env yükleyici (Next.js bunu kendisi yapar).
import fs from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.warn(`[env] ${file} okunamadı: ${(err as Error).message}`);
    }
  }
}
