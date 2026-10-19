import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { upsertConnection } from "@/lib/services/connections";

/** Anthropic bağlantı testi: model bilgisini okur (ücretli üretim çağrısı yapmaz). */
export async function testAnthropic() {
  if (!config.anthropic.apiKey) return { ok: false, detail: "ANTHROPIC_API_KEY tanımlı değil. Uygulama DEMO modunda çalışıyor." };
  await upsertConnection("anthropic", null, { status: "testing" });
  try {
    const client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 0 });
    const m = await client.models.retrieve(config.anthropic.model);
    await upsertConnection("anthropic", null, { status: "connected", lastError: null, config: { model: m.id } });
    return { ok: true, detail: `Bağlandı: ${m.display_name ?? m.id}` };
  } catch (err) {
    const status = err instanceof Anthropic.AuthenticationError ? "reauth_required" : "error";
    const msg = err instanceof Anthropic.APIError ? `${err.status ?? ""} ${err.name}` : (err as Error).message;
    await upsertConnection("anthropic", null, { status, lastError: msg });
    return { ok: false, detail: `Anthropic testi başarısız: ${msg}` };
  }
}
