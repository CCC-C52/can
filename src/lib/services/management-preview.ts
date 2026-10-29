/**
 * Allowlist output projection. Never expose arbitrary model-produced JSON,
 * credentials, provider requests, private prompts, or storage locations.
 */
type UnknownRecord = Record<string, unknown>;
const record = (v: unknown): UnknownRecord => v && typeof v === "object" && !Array.isArray(v) ? v as UnknownRecord : {};
const text = (v: unknown) => typeof v === "string" ? v.slice(0, 1200) : "";
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
export function publicOutputPreview(agent: string, content: unknown) {
  if (agent !== "video") return null;
  const c = record(content);
  const videos = Array.isArray(c.videos) ? c.videos.slice(0, 10) : [];
  return {
    summary: text(c.summary),
    videos: videos.map(v => {
      const item = record(v);
      return {
        id: text(item.id), mode: text(item.mode), format: text(item.format),
        durationSeconds: number(item.duration_s),
        scenes: (Array.isArray(item.script) ? item.script.slice(0, 20) : []).map(scene => {
          const s = record(scene);
          return { start: number(s.t_start), end: number(s.t_end), visual: text(s.visual),
            voiceover: text(s.voiceover), onScreenText: text(s.on_screen_text) };
        }),
        musicNote: text(item.music_note),
      };
    }),
  };
}
