// Basit bellek içi kayan pencere hız sınırlayıcı (tek web örneği için yeterli).
const g = globalThis as unknown as { __rl?: Map<string, number[]> };
const hits = (g.__rl ??= new Map());

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfterS: number } {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t: number) => now - t < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return { ok: false, retryAfterS: Math.ceil((windowMs - (now - list[0])) / 1000) };
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return { ok: true, retryAfterS: 0 };
}
