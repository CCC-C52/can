import { describe, expect, it } from "vitest";
import { publicOutputPreview } from "@/lib/services/management-preview";

describe("FriBee management API data minimization", () => {
  it("returns only allowlisted fields for video plans", () => {
    const preview = publicOutputPreview("video", {
      summary: "Cinematic Space Alien",
      apiKey: "secret-do-not-return",
      videos: [{
        id: "scene-1", mode: "edit_existing", format: "9:16", duration_s: 15,
        storage_key: "private-bucket-key", provider_token: "hidden",
        script: [{ t_start: 0, t_end: 5, visual: "Dark studio", voiceover: "", on_screen_text: "FriBee", credentials: "hidden" }],
        music_note: "licensed audio only",
      }],
    });
    const json = JSON.stringify(preview);
    expect(json).toContain("Cinematic Space Alien");
    expect(json).not.toContain("secret-do-not-return");
    expect(json).not.toContain("private-bucket-key");
    expect(json).not.toContain("provider_token");
    expect(json).not.toContain("credentials");
  });

  it("does not expose arbitrary non-video output bodies", () => {
    expect(publicOutputPreview("shopify", { privateToken: "secret" })).toBeNull();
  });

  it("limits scene count and text length", () => {
    const preview = publicOutputPreview("video", {
      summary: "x".repeat(10000),
      videos: [{ script: Array.from({ length: 50 }, () => ({ visual: "y".repeat(3000) })) }],
    });
    expect(preview?.summary.length).toBe(1200);
    expect(preview?.videos[0].scenes).toHaveLength(20);
    expect(preview?.videos[0].scenes[0].visual.length).toBe(1200);
  });
});
