import { NextResponse } from "next/server";
import { q1 } from "@/lib/db/pool";
import { completeInstagramOAuth } from "@/lib/adapters/instagram";
import { upsertConnection } from "@/lib/services/connections";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (kind: "ok" | "err", msg: string) => NextResponse.redirect(new URL(`/entegrasyonlar?${kind}=${encodeURIComponent(msg)}`, req.url));
  const state = url.searchParams.get("state") ?? "";
  const row = await q1<{ brand_id: string }>(`DELETE FROM oauth_states WHERE state = $1 AND provider = 'instagram' AND expires_at > now() RETURNING brand_id`, [state]);
  if (!row) return back("err", "Geçersiz veya süresi dolmuş yetkilendirme isteği.");
  if (url.searchParams.get("error")) return back("err", `Instagram yetkilendirmesi reddedildi: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`);
  const code = url.searchParams.get("code");
  if (!code) return back("err", "Yetkilendirme kodu yok.");
  try {
    await completeInstagramOAuth(row.brand_id, code.replace(/#_$/, ""));
    await audit({ brandId: row.brand_id, actor: "user", action: "connection.instagram", message: "Instagram bağlandı" });
    return back("ok", "Instagram bağlandı.");
  } catch (err) {
    await upsertConnection("instagram", row.brand_id, { status: "error", lastError: (err as Error).message });
    return back("err", `Instagram bağlantısı başarısız: ${(err as Error).message}`);
  }
}
