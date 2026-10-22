import { describe, it, expect, afterEach, vi } from "vitest";
import { buildEvent, capture, telemetryEnabled } from "@/lib/telemetry";
import { toolCatalog, stateFromConnection } from "@/lib/services/tool-catalog";
import { getLimits, setSetting } from "@/lib/settings";
import { q } from "@/lib/db/pool";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe("PostHog telemetrisi (isteğe bağlı)", () => {
  it("anahtar yoksa kapalıdır ve hiçbir ağ çağrısı yapılmaz", () => {
    delete process.env.POSTHOG_API_KEY;
    expect(telemetryEnabled()).toBe(false);
    const f = vi.fn();
    capture("x", {}, { fetchImpl: f as any });
    expect(f).not.toHaveBeenCalled();
  });

  it("olay gövdesi: yalnızca izinli alanlar, maskelenmiş hata, kişi profili yok", () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    const ev = buildEvent("api.error", {
      route: "/api/x", durationMs: 12, brandId: "b-1", instruction: "secret customer brief", email: "a@b.com", prompt: "p",
    }, new Error("auth failed key=sk-ant-abcdefghijklmnopqrstu"));
    expect(ev.event).toBe("$exception");
    expect(ev.distinct_id).toMatch(/^aiops-server-/);
    const p = ev.properties as Record<string, any>;
    expect(p.$process_person_profile).toBe(false);
    expect(p.route).toBe("/api/x");
    expect(p.durationMs).toBe(12);
    for (const k of ["brandId", "instruction", "email", "prompt"]) expect(p[k]).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain("abcdefghijklmnop");
    expect(p.$exception_list[0].type).toBe("Error");
  });

  it("yapılandırılmışsa POST /i/v0/e/ ile gönderilir; gönderim hatası yutulur", async () => {
    process.env.POSTHOG_API_KEY = "phc_test";
    process.env.POSTHOG_HOST = "https://eu.i.posthog.com/";
    const f = vi.fn(async () => { throw new Error("network down"); });
    expect(() => capture("task_failed", { agent: "video" }, { fetchImpl: f as any })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
    const body = JSON.parse(String(init.body));
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("aiops.task_failed");
    expect(body.properties.agent).toBe("video");
  });
});

describe("Entegrasyon kataloğu", () => {
  it("yapılandırılmamış hiçbir araç 'Etkin' görünmez", async () => {
    for (const k of ["FIRECRAWL_API_KEY", "POSTHOG_API_KEY", "AIOPS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];
    const cat = await toolCatalog();
    const by = Object.fromEntries(cat.map((t) => [t.id, t.state]));
    expect(cat).toHaveLength(10);
    expect(by).toMatchObject({
      anthropic_cache: "requires_key", firecrawl: "requires_key", posthog: "requires_key", playwright: "active",
      remotion: "requires_license", composio: "disabled_security", omniroute: "unsupported",
      ruflo: "unsupported", claude_mem: "unsupported", task_observer: "unsupported",
    });
    expect(cat.filter((t) => t.state === "active").map((t) => t.id)).toEqual(["playwright"]);
  });

  it("Firecrawl: anahtar var ama ayar kapalı → 'yapılandırılmadı'; açık → 'Etkin'", async () => {
    const saved = (await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'limits'`))[0]?.value ?? null;
    try {
      process.env.FIRECRAWL_API_KEY = "fc";
      const cur = await getLimits();
      await setSetting("limits", { ...cur, webResearch: false });
      expect((await toolCatalog()).find((t) => t.id === "firecrawl")!.state).toBe("not_configured");
      await setSetting("limits", { ...cur, webResearch: true });
      expect((await toolCatalog()).find((t) => t.id === "firecrawl")!.state).toBe("active");
    } finally {
      if (saved === null) await q(`DELETE FROM settings WHERE key = 'limits'`);
      else await setSetting("limits", saved);
    }
  });

  it("bağlantı durumları ortak ölçeğe doğru çevrilir", () => {
    delete process.env.OPENAI_API_KEY;
    expect(stateFromConnection("openai_images", "not_connected")).toBe("requires_key");
    process.env.OPENAI_API_KEY = "x";
    expect(stateFromConnection("openai_images", "not_connected")).toBe("not_configured");
    expect(stateFromConnection("openai_images", "error")).toBe("not_configured");
    expect(stateFromConnection("openai_images", "connected")).toBe("active");
    expect(stateFromConnection("tiktok", "unsupported")).toBe("unsupported");
  });
});
