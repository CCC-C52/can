import { describe, it, expect, afterEach, vi } from "vitest";
import { AnthropicAdapter } from "@/lib/models/anthropic";
import { StrategySchema } from "@/lib/agents/schemas";
import { PermanentError, TransientError } from "@/lib/models/types";

// Gerçek API çağrılmaz. Sahte SSE akışıyla istek biçimi ve yanıt işleme doğrulanır.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const sample = {
  summary: "s", audience_segments: [], positioning: "p", key_messages: ["m"],
  campaign: { name: "c", objective: "o", phases: [] }, content_themes: [], ad_ideas: [], unknowns: [],
};

function sse(text: string, stop = "end_turn", usage = { input_tokens: 1000, output_tokens: 500 }) {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body =
    ev("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } }) +
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }) +
    ev("message_stop", { type: "message_stop" });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("AnthropicAdapter (sahte HTTP)", () => {
  it("yapılandırılmış çıktı, fallback ve adaptive thinking ile istek atar; maliyeti kullanımdan hesaplar", async () => {
    let captured: any;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => { captured = { headers: new Headers(init.headers), body: JSON.parse(init.body) }; return sse(JSON.stringify(sample)); }) as any;
    const a = new AnthropicAdapter("claude-opus-5-5", "sk-ant-test");
    const r = await a.generate({ agent: "marketing", purpose: "work", system: "sys", user: "usr", schema: StrategySchema, maxTokens: 4000, demoInput: null });
    expect(r.data.summary).toBe("s");
    expect(r.isDemo).toBe(false);
    expect(r.actualCostUsd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 8);
    expect(captured.body.model).toBe("claude-opus-5-5");
    expect(captured.body.thinking).toEqual({ type: "adaptive" });
    expect(captured.body.fallbacks).toBe("default");
    expect(captured.body.output_config.format.type).toBe("json_schema");
    expect(captured.body.output_config.format.schema.additionalProperties).toBe(false);
    expect(captured.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(captured.body.stream).toBe(true);
  });

  it("görüntü girdileri base64 görüntü blokları olarak etiketleriyle birlikte gönderilir", async () => {
    let body: any;
    globalThis.fetch = vi.fn(async (_u: any, init: any) => { body = JSON.parse(init.body); return sse(JSON.stringify(sample)); }) as any;
    const a = new AnthropicAdapter("claude-opus-5-5", "sk-ant-test");
    await a.generate({ agent: "quality", purpose: "vision", system: "s", user: "analiz et", schema: StrategySchema, maxTokens: 100, demoInput: null,
      images: [{ mediaType: "image/jpeg", base64: "QUJD", label: "Kare 1 · 0.5 sn" }] });
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "Kare 1 · 0.5 sn" });
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
    expect(content.at(-1)).toEqual({ type: "text", text: "analiz et" });
  });

  it("şemaya uymayan çıktı geçici hata; reddetme kalıcı hata olur", async () => {
    globalThis.fetch = vi.fn(async () => sse(JSON.stringify({ wrong: true }))) as any;
    const a = new AnthropicAdapter("claude-opus-5-5", "sk-ant-test");
    await expect(a.generate({ agent: "marketing", purpose: "work", system: "s", user: "u", schema: StrategySchema, maxTokens: 100, demoInput: null })).rejects.toBeInstanceOf(TransientError);
    globalThis.fetch = vi.fn(async () => sse("", "refusal")) as any;
    await expect(new AnthropicAdapter("claude-opus-5-5", "sk-ant-test").generate({ agent: "marketing", purpose: "work", system: "s", user: "u", schema: StrategySchema, maxTokens: 100, demoInput: null })).rejects.toBeInstanceOf(PermanentError);
  });

  it("401 kalıcı, 529/500 geçici hata olarak sınıflanır", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ type: "error", error: { type: "authentication_error", message: "bad key" } }, { status: 401 })) as any;
    await expect(new AnthropicAdapter("claude-opus-5-5", "sk-ant-test").generate({ agent: "marketing", purpose: "work", system: "s", user: "u", schema: StrategySchema, maxTokens: 100, demoInput: null })).rejects.toBeInstanceOf(PermanentError);
    globalThis.fetch = vi.fn(async () => Response.json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, { status: 529 })) as any;
    await expect(new AnthropicAdapter("claude-opus-5-5", "sk-ant-test").generate({ agent: "marketing", purpose: "work", system: "s", user: "u", schema: StrategySchema, maxTokens: 100, demoInput: null })).rejects.toBeInstanceOf(TransientError);
  });
});
