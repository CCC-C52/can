import type { MetadataRoute } from "next";
import { primaryBrand, APP_BG } from "@/lib/services/pwa";

export const dynamic = "force-dynamic";

/** Web uygulaması bildirimi: ana ekrana ekleme (iPhone, Android, masaüstü). Özel veri içermez. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const brand = await primaryBrand();
  const name = brand ? `${brand.name} AI Operations Studio` : "AI Operations Studio";
  return {
    name,
    short_name: brand?.name?.slice(0, 12) ?? "AI Ops",
    description: "Marka, PR ajansı ve yaratıcı üretim yönetim paneli",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: APP_BG,
    theme_color: APP_BG,
    lang: "tr",
    icons: [
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
