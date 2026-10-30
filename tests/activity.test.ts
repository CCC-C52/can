import { describe, it, expect, beforeAll } from "vitest";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { finishedTasksSince } from "@/lib/services/activity";

// Panel sesli uyarısı: yalnızca seçili markanın, verilen andan sonra onaya düşen/biten/başarısız olan görevleri döner.

let a: string, b: string;
async function project(brandId: string) {
  return (await q1<{ id: string }>(`INSERT INTO projects (brand_id, title, instruction, status, idempotency_key) VALUES ($1,'p','i','running',$2) RETURNING id`, [brandId, `act-${brandId}`]))!.id;
}
async function task(brandId: string, projectId: string, key: string, status: string, finishedAgo: number | null) {
  await q(
    `INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status, finished_at)
     VALUES ($1,$2,$3,'video','render',$3,'i',$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() - ($5::int || ' seconds')::interval END)`,
    [brandId, projectId, key, status, finishedAgo],
  );
}

beforeAll(async () => {
  a = (await createBrand({ name: "Uyarı A" })).id;
  b = (await createBrand({ name: "Uyarı B" })).id;
});

describe("Sesli uyarı (biten görevler)", () => {
  it("ilk sorgu yalnızca sunucu saatini döner; sonra yalnızca bu markanın yeni bitenleri gelir", async () => {
    const first = await finishedTasksSince(a, null);
    expect(first.events).toEqual([]);
    const pa = await project(a), pb = await project(b);
    await task(a, pa, "Videoyu render et", "approval_pending", 0);
    await task(a, pa, "Görselleri üret", "failed", 0);
    await task(a, pa, "İptal edilen", "cancelled", 0);
    await task(a, pa, "Çalışan", "running", null);
    await task(a, pa, "Eski", "completed", 3600);
    await task(b, pb, "Başka marka", "completed", 0);

    const since = new Date(Date.now() - 60_000).toISOString();
    const r = await finishedTasksSince(a, since);
    expect(r.events.map((e) => [e.title, e.label, e.ok, e.agent])).toEqual(expect.arrayContaining([
      ["Videoyu render et", "Onay bekliyor", true, "Video Uzmanı"],
      ["Görselleri üret", "Başarısız", false, "Video Uzmanı"],
    ]));
    expect(r.events).toHaveLength(2);
    expect(await finishedTasksSince(a, "geçersiz")).toMatchObject({ events: [] });
  });
});
