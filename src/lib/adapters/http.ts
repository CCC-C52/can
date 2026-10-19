import { TransientError, PermanentError } from "@/lib/models/types";

/** Sonucu belirsiz kalan istek (ör. zaman aşımı yanıt gelmeden). Otomatik tekrar GÖNDERİLMEZ. */
export class UncertainOutcomeError extends Error {}

export async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number; idempotent?: boolean } = {}): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    // Ağ hatası: istek sunucuya ulaşmış olabilir. Yazma işlemlerinde sonuç belirsizdir.
    if (init.idempotent === false) throw new UncertainOutcomeError(`İstek sonucu belirsiz: ${(err as Error).name}`);
    throw new TransientError(`Ağ hatası: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (res.status === 429 || res.status >= 500) {
    if (init.idempotent === false && res.status >= 500) throw new UncertainOutcomeError(`Sunucu hatası ${res.status}; işlem gerçekleşmiş olabilir.`);
    throw new TransientError(`Geçici hata ${res.status}`);
  }
  if (res.status === 401 || res.status === 403) throw new PermanentError(`Yetki hatası ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (!res.ok) throw new PermanentError(`İstek reddedildi ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
