import { NextResponse, type NextRequest } from "next/server";
import { loginRequired, SESSION_COOKIE, verifySession } from "@/lib/auth";

// Kimlik doğrulama ve temel güvenlik başlıkları. Webhook uçları imza ile doğrulanır, oturum gerektirmez.
const PUBLIC = ["/login", "/api/webhooks/", "/_next/", "/favicon"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname.startsWith(p));
  if (!isPublic && loginRequired() && !verifySession(req.cookies.get(SESSION_COOKIE)?.value)) {
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
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
