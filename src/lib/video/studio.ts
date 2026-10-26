// Video Stüdyosu talebi. Stüdyo formu talimata makinece okunabilir satırlar yazar; görev motoru bunları proje
// talimatından okur (yönetici talimatı yeniden yazsa bile kaybolmaz) ve video uzmanına, kalite kontrolüne ve demo
// modeline aynı talebi verir.
//   Stüdyo modu: hybrid (AI sahne: 2 × 6 sn)
//   Ürün referans fotoğrafları: shirt.jpg [id:…], back.jpg [id:…]

export const STUDIO_MODES = ["archive", "ai", "hybrid"] as const;
export type StudioMode = (typeof STUDIO_MODES)[number];
export type StudioRequest = { mode: StudioMode; aiScenes: number; sceneSeconds: number; photoIds: string[] };

export const STUDIO_MAX_AI_SCENES = 3;
export const STUDIO_MAX_PHOTOS = 3;

export const STUDIO_MODE_LABEL: Record<StudioMode, string> = {
  archive: "Arşiv kurgusu (yalnızca gerçek çekimler)",
  ai: "AI ile üret (Gemini Omni sahneleri + marka kapanışı)",
  hybrid: "Karma (AI sahneleri + gerçek ürün fotoğrafları + arşiv çekimleri)",
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function studioDirectiveLines(req: StudioRequest, photos: { id: string; filename: string }[]): string[] {
  const lines = [`Stüdyo modu: ${req.mode}${req.mode === "archive" ? "" : ` (AI sahne: ${req.aiScenes} × ${req.sceneSeconds} sn)`}`];
  if (photos.length) lines.push(`Ürün referans fotoğrafları: ${photos.map((p) => `${p.filename.replace(/[[\]\n]/g, "")} [id:${p.id}]`).join(", ")}`);
  return lines;
}

/** Talimattaki stüdyo talebi; yoksa null. Fotoğraf kimlikleri marka kapsamında ayrıca doğrulanmalıdır. */
export function parseStudioRequest(text: string | null | undefined): StudioRequest | null {
  const m = /Stüdyo modu:\s*(archive|ai|hybrid)\b(?:\s*\(AI sahne:\s*(\d{1,2})\s*[×x]\s*(\d{1,2})\s*sn\))?/i.exec(text ?? "");
  if (!m) return null;
  const mode = m[1].toLowerCase() as StudioMode;
  const line = /Ürün referans fotoğrafları:\s*([^\n]*)/i.exec(text ?? "")?.[1] ?? "";
  const photoIds = [...new Set([...line.matchAll(new RegExp(`\\[id:(${UUID.source})\\]`, "gi"))].map((x) => x[1].toLowerCase()))].slice(0, STUDIO_MAX_PHOTOS);
  const aiScenes = mode === "archive" ? 0 : Math.min(STUDIO_MAX_AI_SCENES, Math.max(1, Number(m[2] ?? 2)));
  const sceneSeconds = mode === "archive" ? 0 : Math.min(10, Math.max(3, Number(m[3] ?? 6)));
  return { mode, aiScenes, sceneSeconds, photoIds };
}

export const wantsAiScenes = (s: StudioRequest | null | undefined) => !!s && s.mode !== "archive";

/** Video Stüdyosu formundan Ana Yönetici talimatı (makinece okunur stüdyo satırlarıyla). */
export function buildStudioInstruction(args: {
  mode: StudioMode;
  videos: { id: string; filename: string }[];
  photos: { id: string; filename: string }[];
  minSeconds: number;
  maxSeconds: number;
  platform: string;
  transition: "cut" | "fade";
  aiScenes: number;
  sceneSeconds: number;
  goal: string;
}) {
  const req: StudioRequest = { mode: args.mode, aiScenes: args.mode === "archive" ? 0 : args.aiScenes, sceneSeconds: args.mode === "archive" ? 0 : args.sceneSeconds, photoIds: args.photos.map((p) => p.id) };
  const files = args.videos.map((v) => v.filename).join(", ");
  const head = args.mode === "archive"
    ? [
        `Video Stüdyosu talebi: ${files} dosyalarından ${args.minSeconds}-${args.maxSeconds} saniyelik ${args.platform} videosu hazırla.`,
        `Yalnızca bu gerçek çekimleri ve doğrulanmış sahne analizini kullan; geçiş türü: ${args.transition === "fade" ? "yumuşak geçiş" : "kesme"}. Ürünün rengini ve görünümünü değiştirme.`,
      ]
    : [
        `Video Stüdyosu talebi: ${args.minSeconds}-${args.maxSeconds} saniyelik premium ${args.platform} reklamı hazırla.`,
        `Google Gemini Omni ile ${args.aiScenes} adet ${args.sceneSeconds} saniyelik sinematik AI sahnesi üret (generate_new)${args.photos.length ? "; seçilen gerçek ürün fotoğraflarını referans olarak gönder, baskı, renk, logo ve oranlar değişmesin" : ""}.`,
        `Sahneleri${args.photos.length ? ", hareketlendirilmiş ürün fotoğraflarını" : ""}${args.mode === "hybrid" && files ? ` ve ${files} arşiv çekimlerinden doğrulanmış sahneleri` : ""} tek bir reklam kurgusunda (compose) birleştir; açılışta kısa bir kanca, sonda CTA ve marka kapanışı olsun.`,
      ];
  return [
    ...head,
    ...studioDirectiveLines(req, args.photos),
    args.goal ? `Amaç ve notlar: ${args.goal}` : "",
    "Ekran yazıları ve altyazı marka içerik dilinde olsun. Yayınlama; onay için hazırla.",
  ].filter(Boolean).join("\n");
}
