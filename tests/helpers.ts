import { Engine } from "@/lib/orchestrator/engine";
import { q } from "@/lib/db/pool";

/** İşleyiciyi kuyruk boşalana kadar çalıştırır (testler için). */
export async function runUntilIdle(engine: Engine, maxTicks = 200) {
  for (let i = 0; i < maxTicks; i++) {
    const n = await engine.tick();
    await engine.waitInflight();
    if (n === 0) {
      const pending = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM tasks WHERE status IN ('ready','review_pending','running') AND (next_attempt_at IS NULL OR next_attempt_at <= now())`,
      );
      const planned = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'planned'`);
      if (pending[0].n === 0) {
        await engine.tick(); // planlananları hazırla
        await engine.waitInflight();
        const again = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE status IN ('ready','review_pending','running')`);
        if (again[0].n === 0 && planned[0].n >= 0) return i;
      }
    }
  }
  throw new Error("Kuyruk boşalmadı");
}

export function key() {
  return `test-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
