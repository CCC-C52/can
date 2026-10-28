"use client";
import { useEffect } from "react";

/**
 * Service worker kaydı (yalnızca üretim derlemesinde). Sürüm değişince yeni çalışan hemen etkinleşir ve eski önbellek silinir;
 * sayfa verisi önbelleğe alınmadığı için kullanıcı her zaman canlı veriyi görür.
 */
export function PwaRegister({ version, enabled }: { version: string; enabled: boolean }) {
  useEffect(() => {
    if (!enabled || !("serviceWorker" in navigator)) return;
    const url = `/sw.js?v=${encodeURIComponent(version)}`;
    navigator.serviceWorker.register(url, { scope: "/", updateViaCache: "none" }).catch(() => {});
  }, [version, enabled]);
  return null;
}
