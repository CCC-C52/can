import { NextResponse, type NextRequest } from "next/server";
import { loginRequired, sessionCookieName, verifySession } from "@/lib/auth";
import { config as appConfig } from "@/lib/config";
import { requestIdFrom } from "@/lib/log";

// Kimlik doğrulama ve temel güvenlik başlıkları. Webhook uçları imza ile doğrulanır, oturum gerektirmez.
// Herkese açık olanlar: giriş sayfası, imza doğrulamalı webhook'lar, bilgi sızdırmayan sağlık kontrolü, statik derleme dosyaları, PWA dosyaları.
// /api/release/: dağıtım hattının uçları; oturum yerine RELEASE_STATUS_TOKEN ile korunur (belirteç yoksa uç kapalıdır).
// PWA: bildirim, uygulama simgesi (yalnızca marka logosu), service worker, çevrimdışı sayfa ve yazı tipleri — özel veri içermez.
const PUBLIC = ["/login", "/api/webhooks/", "/api/health", "/api/release/", "/_next/static/", "/favicon", "/manifest.webmanifest", "/app-icon/", "/sw.js", "/offline.html", "/fonts/"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Her isteğe bir kimlik: sunucu kodu ve günlükler bunu kullanır, yanıtla birlikte istemciye döner (hata bildirimi için)
  const requestId = requestIdFrom(req.headers);
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set("x-request-id", requestId);
  const withId = (r: NextResponse) => { r.headers.set("X-Request-Id", requestId); return r; };
  const isPublic = PUBLIC.some((p) => pathname.startsWith(p));
  if (!isPublic && loginRequired() && !verifySession(req.cookies.get(sessionCookieName())?.value)) {
    if (pathname.startsWith("/api/")) return withId(NextResponse.json({ error: "Oturum gerekli" }, { status: 401 }));
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return withId(NextResponse.redirect(url));
  }
  // Durum değiştiren API çağrılarında aynı köken kontrolü (CSRF)
  if (req.method !== "GET" && pathname.startsWith("/api/") && !pathname.startsWith("/api/webhooks/")) {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.headers.get("host")) return withId(NextResponse.json({ error: "Geçersiz köken" }, { status: 403 }));
  }
  const res = withId(NextResponse.next({ request: { headers: reqHeaders } }));
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
