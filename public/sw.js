/*
 * Service worker — güvenli önbellekleme.
 *  - Yalnızca herkese açık, içerik karmalı derleme dosyaları (/_next/static), yazı tipleri ve çevrimdışı sayfa önbelleğe alınır.
 *  - Sayfalar (HTML), API yanıtları, medya ve marka verileri ÖNBELLEĞE ALINMAZ: özel iş verisi cihazda saklanmaz.
 *  - Sürüm, kayıt adresindeki ?v= değerinden gelir; yeni dağıtımda eski önbellek silinir ve yeni sürüm hemen etkinleşir.
 */
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = `aiops-static-${VERSION}`;
const PRECACHE = ["/offline.html", "/fonts/inter-latin.woff2", "/fonts/inter-latin-ext.woff2", "/fonts/playfair-latin.woff2", "/fonts/playfair-latin-ext.woff2"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("aiops-") && k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/fonts/")) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && res.type === "basic") cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }
  if (req.mode === "navigate") {
    // Ağ öncelikli; yalnızca bağlantı yoksa veri içermeyen çevrimdışı sayfa
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
  }
});
