import { NextResponse, type NextRequest } from "next/server";
import { loginRequired, sessionCookieName, verifySession } from "@/lib/auth";
import { config as appConfig } from "@/lib/config";

// Kimlik doğrulama ve temel güvenlik başlıkları. Webhook uçları imza ile doğrulanır, oturum gerektirmez.
// Herkese açık olanlar: giriş sayfası, imza doğrulamalı webhook'lar, bilgi sızdırmayan sağlık kontrolü, statik derleme dosyaları.
const PUBLIC = ["/login", "/api/webhooks/", "/api/health", "/_next/static/", "/favicon"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname.startsWith(p));
  if (!isPublic && loginRequired() && !verifySession(req.cookies.get(sessionCookieName())?.value)) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Oturum gerekli" }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  // Durum değiştiren API çağrılarında aynı köken kontrolü (CSRF)
  if (req.method !== "GET" && pathname.startsWith("/api/") && !pathname.startsWith("/api/webhooks/")) {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Geçersiz köken" }, { status: 403 });
  }
  const res = NextResponse.next();
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "same-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (appConfig.appMode === "production") res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Panel sayfaları arama motorlarına ve ara önbelleklere kapalı
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

export const config = { matcher: ["/((?!_next/static).*)"] };
