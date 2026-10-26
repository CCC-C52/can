import { NextResponse } from "next/server";
import { completeDriveOAuth, consumeDriveState, safeError } from "@/lib/drive/source";
import { upsertConnection } from "@/lib/services/connections";

export const runtime = "nodejs";

/** Google OAuth dönüşü. Marka, istemciden değil sunucuda saklanan tek kullanımlık state'ten alınır. Kod/belirteç günlüğe yazılmaz. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (kind: "ok" | "err", msg: string) => NextResponse.redirect(new URL(`/drive-arsivi?${kind}=${encodeURIComponent(msg)}`, req.url));
  const brandId = await consumeDriveState(url.searchParams.get("state") ?? "");
  if (!brandId) return back("err", "Geçersiz veya süresi dolmuş yetkilendirme isteği.");
  const denied = url.searchParams.get("error");
  if (denied) return back("err", `Google yetkilendirmesi reddedildi (${denied.replace(/[^a-z_]/gi, "").slice(0, 40)}).`);
  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return back("err", "Yetkilendirme kodu yok.");
  try {
    const r = await completeDriveOAuth(brandId, code);
    return back("ok", `Google Drive bağlandı${r.email ? ` (${r.email})` : ""}. Şimdi arşiv klasörünü seçin.`);
  } catch (err) {
    const msg = safeError(err);
    await upsertConnection("google_drive", brandId, { status: "error", lastError: msg }).catch(() => {});
    return back("err", `Google Drive bağlantısı başarısız: ${msg}`);
  }
}
