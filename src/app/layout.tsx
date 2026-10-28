import type { Metadata, Viewport } from "next";
import "./globals.css";
import { releaseCommit } from "@/lib/release";
import { PwaRegister } from "@/components/pwa";

export const metadata: Metadata = {
  title: { default: "AI Operations Studio", template: "%s · AI Operations Studio" },
  description: "Marka, PR ajansı ve yaratıcı üretim yönetim paneli",
  robots: { index: false, follow: false },
  applicationName: "AI Operations Studio",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "AI Ops" },
  icons: { icon: [{ url: "/app-icon/192", sizes: "192x192", type: "image/png" }], apple: [{ url: "/app-icon/180", sizes: "180x180", type: "image/png" }] },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#09090b", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body className="min-h-screen font-sans">
        {children}
        <PwaRegister version={releaseCommit()?.slice(0, 12) ?? "dev"} enabled={process.env.NODE_ENV === "production"} />
      </body>
    </html>
  );
}
