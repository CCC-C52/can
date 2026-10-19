import { redirect } from "next/navigation";
import { redact } from "@/lib/security/crypto";

export function str(fd: FormData, k: string): string {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
}

export function withMsg(path: string, kind: "ok" | "err", msg: string) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${kind}=${encodeURIComponent(redact(msg).slice(0, 400))}`;
}

/** Eylemi çalıştırır; sonucu sorgu parametresiyle sayfaya bildirir. */
export async function act(path: string, fn: () => Promise<string | { ok: string; to?: string }>): Promise<never> {
  let target: string;
  try {
    const r = await fn();
    target = typeof r === "string" ? withMsg(path, "ok", r) : withMsg(r.to ?? path, "ok", r.ok);
  } catch (err) {
    if ((err as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw err;
    target = withMsg(path, "err", (err as Error).message || "Beklenmeyen hata");
  }
  redirect(target);
}
