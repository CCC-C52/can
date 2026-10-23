/**
 * Commercial video campaign presets for FriBee AI Operations Studio.
 * Pure planning data: does not call providers, spend money or publish.
 * AI-generated footage must be reviewed against the actual product before use.
 */
export const CINEMATIC_PRESETS = {
  cinematic: {
    label: "Cinematic Fashion",
    camera: "slow dolly-in, controlled orbit, macro fabric detail",
    lighting: "dramatic soft key light, rich shadows, premium editorial contrast",
    pacing: "deliberate cuts with a strong final product reveal",
  },
  futuristic: {
    label: "Futuristic",
    camera: "smooth tracking, restrained dynamic perspective",
    lighting: "neon rim light with realistic fabric texture",
    pacing: "rhythmic transitions without distorting the garment",
  },
  anime: {
    label: "Anime Inspired",
    camera: "stylized camera movement, sharp hero framing",
    lighting: "graphic color contrast with physically plausible garment lighting",
    pacing: "energetic, music-synchronized scene progression",
  },
  luxury: {
    label: "Luxury Editorial",
    camera: "minimal camera motion, close-up stitching and print",
    lighting: "clean studio highlights and nuanced tonal separation",
    pacing: "slow premium reveal",
  },
} as const;

export type CinematicStyle = keyof typeof CINEMATIC_PRESETS;
export type CommercialBrief = {
  collection: string;
  style: CinematicStyle;
  aspectRatio: "9:16" | "16:9";
  durationSeconds: 15 | 30;
  referenceAssetIds: string[];
  licensedAudioConfirmed: boolean;
};

export function buildCommercialBrief(input: CommercialBrief) {
  if (!input.collection.trim()) throw new Error("Collection is required");
  if (!input.referenceAssetIds.length || input.referenceAssetIds.some(id => !id.trim())) {
    throw new Error("At least one verified product reference is required");
  }
  const style = CINEMATIC_PRESETS[input.style];
  if (!style) throw new Error("Unknown cinematic style");
  const sceneCount = input.durationSeconds === 15 ? 3 : 5;
  const sceneDuration = input.durationSeconds / sceneCount;
  return {
    title: `FriBee | ${input.collection} | ${style.label}`,
    format: input.aspectRatio,
    durationSeconds: input.durationSeconds,
    referenceAssetIds: [...input.referenceAssetIds],
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      index: i + 1,
      durationSeconds: sceneDuration,
      direction: [
        "Establish the mood with the real garment as the visual anchor.",
        "Reveal authentic fabric texture, oversized silhouette and artwork.",
        "Finish with a clear product hero frame and brand-safe ending.",
      ][Math.min(i, 2)],
      camera: style.camera,
      lighting: style.lighting,
      pacing: style.pacing,
    })),
    safeguards: {
      preserveProductArtwork: true,
      preserveLogoAndLettering: true,
      preserveColorAndFit: true,
      requiresHumanProductReview: true,
      requiresCommercialRightsReview: true,
      audioStatus: input.licensedAudioConfirmed ? "licensed-audio-confirmed-by-owner" : "no-audio-until-licensed",
      automaticPublishing: false,
    },
  };
}
