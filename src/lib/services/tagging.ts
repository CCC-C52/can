import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "@/lib/config";
import { anthropicPrice, toStrictJsonSchema } from "@/lib/models/anthropic";
import { assertBudget, recordCost } from "./costs";
import { getMedia, readMediaFile } from "./media";
import { q } from "@/lib/db/pool";
import { audit } from "@/lib/audit";

const TagSchema = z.object({
  tags: z.array(z.string()).describe("Kısa Türkçe etiketler (en fazla 10)"),
  colors: z.array(z.string()).describe("Görünen ana renkler, Türkçe"),
  themes: z.array(z.string()),
  shot_type: z.string().describe("Çekim tipi, ör. 'ürün önden', 'model üzerinde', 'detay'"),
});

/** Görseli Claude ile etiketler. Etiketler "ai" kaynağıyla eklenir; kullanıcı düzeltebilir. Demo modunda çalışmaz. */
export async function tagWithAI(brandId: string, assetId: string): Promise<number> {
  if (!config.anthropic.apiKey) throw new Error("AI etiketleme için AIOPS_ANTHROPIC_API_KEY gerekli. Demo modunda sahte etiket üretilmez.");
  const asset = await getMedia(brandId, assetId);
  if (!asset) throw new Error("Dosya bulunamadı.");
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(asset.mime_type)) throw new Error("Yalnızca görseller etiketlenebilir.");
  if (asset.size_bytes > 5 * 1024 * 1024) throw new Error("Görsel 5 MB'den büyük; AI etiketleme için küçültün.");
  const price = anthropicPrice(config.anthropic.model);
  const estimate = price ? (2000 * price.input + 1000 * price.output) / 1_000_000 : null;
  await assertBudget({ taskId: null, estimateUsd: estimate, service: "anthropic" });
  const client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 1 });
  const data = (await readMediaFile(asset)).toString("base64");
  const res = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1000,
    output_config: { effort: "low", format: { type: "json_schema", schema: toStrictJsonSchema(TagSchema) } },
    system: "You tag fashion/brand media for an archive. Describe only what is visible. Never guess brand claims, materials or prices. Answer in Turkish.",
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: asset.mime_type as "image/jpeg", data } }, { type: "text", text: "Bu görseli etiketle." }] }],
  });
  const usd = price ? (res.usage.input_tokens * price.input + res.usage.output_tokens * price.output) / 1_000_000 : null;
  await recordCost({ brandId, service: "anthropic", kind: "actual", amountUsd: usd, units: res.usage, note: "Medya AI etiketleme" });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const parsed = TagSchema.parse(JSON.parse(text));
  const tags = [...parsed.tags.slice(0, 10).map((tag) => ({ tag, source: "ai" })), { tag: `çekim: ${parsed.shot_type}`, source: "ai" }];
  await q(
    `UPDATE media_assets SET tags = tags || $3::jsonb, colors = (SELECT ARRAY(SELECT DISTINCT unnest(colors || $4::text[]))),
       themes = (SELECT ARRAY(SELECT DISTINCT unnest(themes || $5::text[]))), shot_type = COALESCE(shot_type, $6)
     WHERE id = $1 AND brand_id = $2`,
    [assetId, brandId, JSON.stringify(tags), parsed.colors, parsed.themes, parsed.shot_type],
  );
  await audit({ brandId, actor: "agent:design", action: "media.ai_tag", message: `${asset.filename} AI ile etiketlendi (${tags.length} etiket)` });
  return tags.length;
}
