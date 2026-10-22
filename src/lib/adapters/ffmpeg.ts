import { execFile } from "node:child_process";
import { config } from "@/lib/config";
import { PermanentError, TransientError } from "@/lib/models/types";

// ffmpeg çağrıları için ortak katman:
//  - Süreç başına eşzamanlı ffmpeg işi sınırı (FFMPEG_CONCURRENCY, vars. 1): 512 MB'lık işleyicide analiz ve kurgu
//    aynı anda çalışıp belleği aşmasın.
//  - Hatalar ffmpeg'in kendi hata çıktısıyla (son satırlar) raporlanır; zaman aşımı ayrı sınıflandırılır.

export class FfmpegError extends PermanentError {}
export class FfmpegTimeoutError extends TransientError {}

const LIMIT = Math.max(1, Math.min(4, Number(process.env.FFMPEG_CONCURRENCY ?? 1) || 1));
let active = 0;
const waiters: (() => void)[] = [];

/** Bir ffmpeg işini süreç genelindeki eşzamanlılık sınırı içinde çalıştırır. */
export async function withFfmpegSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= LIMIT) await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/**
 * ffmpeg'i argüman dizisiyle (kabuk yok) çalıştırır. Başarısızlıkta adım adı + ffmpeg hata çıktısının sonu ile
 * FfmpegError, süre dolunca FfmpegTimeoutError atar. İptal sinyali süreci sonlandırır.
 */
export function runFfmpeg(args: string[], opts: { step: string; timeoutMs: number; signal?: AbortSignal; bin?: string }): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(opts.bin ?? config.ffmpegPath, args, { timeout: Math.max(1000, opts.timeoutMs), signal: opts.signal, maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const tail = String(stderr ?? "").trim().split("\n").slice(-6).join(" | ").slice(0, 600);
      if (!err) return resolve({ stderr: String(stderr ?? "") });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
      if (opts.signal?.aborted) return reject(opts.signal.reason ?? err);
      if (e.killed || e.signal === "SIGTERM") return reject(new FfmpegTimeoutError(`ffmpeg (${opts.step}) süre sınırını aştı (${Math.round(opts.timeoutMs / 1000)} sn).`));
      if (e.code === "ENOENT") return reject(new FfmpegError(`ffmpeg bulunamadı (${opts.bin ?? config.ffmpegPath}).`));
      if (e.signal === "SIGKILL") return reject(new FfmpegError(`ffmpeg (${opts.step}) işletim sistemi tarafından sonlandırıldı (bellek yetersiz olabilir).`));
      reject(new FfmpegError(`ffmpeg (${opts.step}) başarısız (çıkış ${e.code ?? e.signal ?? "?"}): ${tail || "hata çıktısı yok"}`));
    });
    child.stdin?.end();
  });
}

/** Dosyanın baştan sona hatasız çözülebildiğini doğrular (oynatılabilirlik kontrolü). */
export async function assertDecodes(file: string, timeoutMs = 120_000) {
  const { stderr } = await runFfmpeg(["-hide_banner", "-v", "error", "-protocol_whitelist", "file", "-threads", "1", "-i", file, "-f", "null", "-"], { step: "çözme doğrulaması", timeoutMs });
  if (stderr.trim()) throw new FfmpegError(`Çıktı dosyası hatasız çözülemedi: ${stderr.trim().split("\n").slice(0, 3).join(" | ").slice(0, 400)}`);
}
