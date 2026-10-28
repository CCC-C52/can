import type { IconName } from "@/components/icons";

export type NavItem = { href: string; label: string; icon: IconName; hint?: string };

// Menü yapısı: Genel bakış · PR Ajansı · Yaratıcı · Marka · İş · Sistem.
// Her bağlantı çalışan bir sayfaya gider; verisi henüz bağlanmamış sayfalar "Kurulum bekliyor" işaretiyle gösterilir.
export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Genel bakış",
    items: [
      { href: "/", label: "Ana ekran", icon: "dashboard" },
      { href: "/sohbet", label: "AI Yönetici", icon: "spark" },
      { href: "/ajanlar", label: "AI Ekibi", icon: "team" },
      { href: "/gorevler", label: "Görev panosu", icon: "board" },
      { href: "/onaylar", label: "Onay Merkezi", icon: "check" },
    ],
  },
  {
    title: "PR Ajansı",
    items: [
      { href: "/pr-ajansi", label: "PR Ajansı", icon: "megaphone", hint: "Ajans merkezi" },
      { href: "/pr-ajansi/strateji", label: "Marka Stratejisi", icon: "strategy", hint: "2026–2034" },
      { href: "/projeler", label: "Kampanya Yönetimi", icon: "flag" },
      { href: "/pr-ajansi/istihbarat", label: "Pazar İstihbaratı", icon: "radar" },
      { href: "/arastirma", label: "Araştırma Merkezi", icon: "search" },
      { href: "/pr-ajansi/medya-iliskileri", label: "Medya İlişkileri", icon: "mic" },
      { href: "/pr-ajansi/influencer", label: "Influencer Ağı", icon: "users" },
      { href: "/takvim", label: "Sosyal Medya", icon: "share" },
      { href: "/pr-ajansi/takvim", label: "İçerik Takvimi", icon: "calendar" },
      { href: "/raporlar", label: "Analitik", icon: "chart", hint: "Analitik ve raporlar" },
    ],
  },
  {
    title: "Yaratıcı",
    items: [
      { href: "/studyo/gorsel", label: "Görsel Stüdyosu", icon: "image" },
      { href: "/studyo/video", label: "Video Stüdyosu", icon: "film" },
      { href: "/taslaklar", label: "İçerik taslakları", icon: "draft" },
      { href: "/onizlemeler", label: "Görsel ve video önizleme", icon: "eye" },
      { href: "/medya", label: "Medya arşivi", icon: "archive" },
    ],
  },
  {
    title: "Marka",
    items: [
      { href: "/koleksiyonlar", label: "Koleksiyonlar", icon: "layers" },
      { href: "/urunler", label: "Ürünler", icon: "tag" },
      { href: "/markalar", label: "Marka Yönetimi", icon: "book", hint: "Marka kılavuzu" },
      { href: "/hafiza", label: "Marka Hafızası", icon: "brain" },
      { href: "/bilgi", label: "Marka Bilgi Merkezi", icon: "library" },
      { href: "/bilgi/beyin", label: "Brand Brain", icon: "search" },
      { href: "/drive-arsivi", label: "Drive Arşivi", icon: "drive" },
    ],
  },
  {
    title: "İş",
    items: [
      { href: "/is/e-ticaret", label: "E-ticaret", icon: "cart" },
      { href: "/is/musteriler", label: "Müşteriler", icon: "user" },
      { href: "/is/satis", label: "Satış Analitiği", icon: "trend" },
    ],
  },
  {
    title: "Sistem",
    items: [
      { href: "/entegrasyonlar", label: "Entegrasyonlar", icon: "plug" },
      { href: "/maliyet", label: "Maliyet Yönetimi", icon: "wallet" },
      { href: "/otomasyon", label: "Otomasyon", icon: "bolt" },
      { href: "/tanilama", label: "Sistem Durumu", icon: "pulse" },
      { href: "/ayarlar", label: "Ayarlar ve geçmiş", icon: "cog" },
    ],
  },
];

export const NAV = NAV_GROUPS.flatMap((g) => g.items);
