import { describe, expect, it } from "vitest";
import { buildCommercialBrief, CINEMATIC_PRESETS } from "../src/lib/cinematic-video";

describe("FriBee commercial cinematic briefs", () => {
  it("offers four distinct creative directions", () => {
    expect(Object.keys(CINEMATIC_PRESETS)).toEqual(["cinematic", "futuristic", "anime", "luxury"]);
  });

  it("builds a 15 second vertical campaign without enabling publication or unlicensed music", () => {
    const brief = buildCommercialBrief({
      collection: "Space Alien",
      style: "cinematic",
      aspectRatio: "9:16",
      durationSeconds: 15,
      referenceAssetIds: ["verified-product-photo"],
      licensedAudioConfirmed: false,
    });
    expect(brief.scenes).toHaveLength(3);
    expect(brief.scenes.reduce((total, scene) => total + scene.durationSeconds, 0)).toBe(15);
    expect(brief.safeguards.requiresHumanProductReview).toBe(true);
    expect(brief.safeguards.automaticPublishing).toBe(false);
    expect(brief.safeguards.audioStatus).toBe("no-audio-until-licensed");
  });

  it("requires a product reference and a collection", () => {
    expect(() => buildCommercialBrief({
      collection: " ", style: "anime", aspectRatio: "9:16", durationSeconds: 15,
      referenceAssetIds: ["photo"], licensedAudioConfirmed: false,
    })).toThrow("Collection is required");
    expect(() => buildCommercialBrief({
      collection: "Anime", style: "anime", aspectRatio: "9:16", durationSeconds: 15,
      referenceAssetIds: [], licensedAudioConfirmed: false,
    })).toThrow("At least one verified product reference is required");
  });
});
