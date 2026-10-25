"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV_GROUPS: { title: string; items: { href: string; label: string }[] }[] = [
  {
    title: "Yönetim",
    items: [
      { href: "/", label: "Ana ekran" },
      { href: "/sohbet", label: "AI Yönetici" },
      { href: "/ajanlar", label: "AI Ekibi" },
      { href: "/gorevler", label: "Görev panosu" },
      { href: "/onaylar", label: "Onay Merkezi" },
    ],
  },
  {
    title: "Üretim",
    items: [
      { href: "/projeler", label: "Kampanya Yönetimi" },
      { href: "/studyo/gorsel", label: "Görsel Stüdyosu" },
      { href: "/studyo/video", label: "Video Stüdyosu" },
      { href: "/taslaklar", label: "İçerik taslakları" },
      { href: "/onizlemeler", label: "Görsel ve video önizleme" },
      { href: "/takvim", label: "Sosyal Medya" },
    ],
  },
  {
    title: "Marka",
    items: [
      { href: "/markalar", label: "Marka Yönetimi" },
      { href: "/hafiza", label: "Marka Hafızası" },
      { href: "/urunler", label: "Ürünler" },
      { href: "/medya", label: "Medya arşivi" },
      { href: "/arastirma", label: "Araştırma Merkezi" },
      { href: "/pr-ajansi", label: "PR Ajansı" },
    ],
  },
  {
    title: "Sistem",
    items: [
      { href: "/raporlar", label: "Analitik" },
      { href: "/maliyet", label: "Maliyet Yönetimi" },
      { href: "/entegrasyonlar", label: "Entegrasyonlar" },
      { href: "/tanilama", label: "Sistem Durumu" },
      { href: "/ayarlar", label: "Ayarlar ve geçmiş" },
    ],
  },
];

export const NAV = NAV_GROUPS.flatMap((g) => g.items);

export function NavLinks() {
  const path = usePathname();
  return (
    <div className="space-y-3">
      {NAV_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.title}</div>
          <ul className="grid grid-cols-2 gap-1 md:grid-cols-1">
            {g.items.map((n) => {
              const active = n.href === "/" ? path === "/" : path === n.href || path.startsWith(`${n.href}/`);
              return (
                <li key={n.href}>
                  <Link href={n.href} aria-current={active ? "page" : undefined} className={`block rounded-lg px-3 py-1.5 text-sm ${active ? "bg-blue-50 font-medium text-brand" : "text-gray-700 hover:bg-gray-100"}`}>
                    {n.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
