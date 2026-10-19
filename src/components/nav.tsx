"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV = [
  { href: "/", label: "Ana ekran" },
  { href: "/sohbet", label: "Ana yönetici" },
  { href: "/gorevler", label: "Görev panosu" },
  { href: "/taslaklar", label: "İçerik taslakları" },
  { href: "/onizlemeler", label: "Görsel ve video" },
  { href: "/onaylar", label: "Onay merkezi" },
  { href: "/takvim", label: "Yayın takvimi" },
  { href: "/markalar", label: "Marka yönetimi" },
  { href: "/urunler", label: "Ürünler" },
  { href: "/medya", label: "Medya arşivi" },
  { href: "/entegrasyonlar", label: "Entegrasyonlar" },
  { href: "/raporlar", label: "Maliyet ve performans" },
  { href: "/ajanlar", label: "Ajanlar" },
  { href: "/ayarlar", label: "Ayarlar ve geçmiş" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <ul className="grid grid-cols-2 gap-1 md:grid-cols-1">
      {NAV.map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <li key={n.href}>
            <Link href={n.href} className={`block rounded-lg px-3 py-2 text-sm ${active ? "bg-blue-50 font-medium text-brand" : "text-gray-700 hover:bg-gray-100"}`}>
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
