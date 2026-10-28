// Arayüz simgeleri: tek renkli, çizgi tabanlı, 24×24 görünüm kutusu. Harici paket yok; currentColor ile renklenir.
// Dekoratiftir (aria-hidden); anlam her zaman yanındaki metinle verilir.

export type IconName =
  | "dashboard" | "spark" | "team" | "board" | "check" | "strategy" | "megaphone" | "radar" | "mic" | "users" | "share"
  | "calendar" | "chart" | "image" | "film" | "draft" | "eye" | "archive" | "layers" | "tag" | "book" | "brain"
  | "library" | "drive" | "cart" | "user" | "trend" | "plug" | "wallet" | "cog" | "bolt" | "pulse" | "search"
  | "arrow-right" | "menu" | "close" | "lock" | "clock" | "shield" | "alert" | "globe" | "flag" | "pause" | "play";

const P: Record<IconName, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7.5" height="9" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.5" /><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.5" /><rect x="3" y="15" width="7.5" height="6" rx="1.5" /></>,
  spark: <><path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8z" /><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
  team: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17.5" cy="9" r="2.5" /><path d="M16 14.2c2.9-.4 5 1.9 5 4.8" /></>,
  board: <><rect x="3" y="4" width="5" height="16" rx="1.2" /><rect x="10" y="4" width="5" height="10" rx="1.2" /><rect x="17" y="4" width="4" height="13" rx="1.2" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.6 2.6L16.2 9.5" /></>,
  strategy: <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M21 20H3" /><path d="M13 7l3-3 3 3" /></>,
  megaphone: <><path d="M3 10v4a1 1 0 001 1h2l5 4V5L6 9H4a1 1 0 00-1 1z" /><path d="M15.5 8.5a5 5 0 010 7" /><path d="M18.5 6a8.5 8.5 0 010 12" /></>,
  radar: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><path d="M12 12l6.4-6.4" /><circle cx="12" cy="12" r="1" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0013 0" /><path d="M12 17.5V21" /></>,
  users: <><circle cx="8" cy="9" r="3" /><circle cx="16" cy="9" r="3" /><path d="M2.5 19c.6-2.8 2.9-4.5 5.5-4.5s4.9 1.7 5.5 4.5" /><path d="M13.6 15.2c.7-.4 1.5-.7 2.4-.7 2.6 0 4.9 1.7 5.5 4.5" /></>,
  share: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="M7.5 15l3.5-4 3 2.5 5-6" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="M21 16l-5-5-8 9" /></>,
  film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  draft: <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  archive: <><rect x="3" y="4" width="18" height="4.5" rx="1" /><path d="M5 8.5V19a1 1 0 001 1h12a1 1 0 001-1V8.5" /><path d="M10 12.5h4" /></>,
  layers: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  tag: <><path d="M3 12V4a1 1 0 011-1h8l9 9-9 9z" /><circle cx="7.5" cy="7.5" r="1.5" /></>,
  book: <><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z" /><path d="M4 19V5" /><path d="M8 7h7" /></>,
  brain: <><path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 003 3h1V4z" /><path d="M15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-3 3h-1V4z" /></>,
  library: <><path d="M4 4v16M8 4v16" /><path d="M12 5l3.5-1 4 15.5-3.5 1z" /></>,
  drive: <><path d="M8.5 4h7l6 10.5-3.5 6h-12L2.5 14.5z" /><path d="M8.5 4l6 10.5h7M2.5 14.5h12l-3.5 6" /></>,
  cart: <><path d="M3 4h2l2.4 11.2a1 1 0 001 .8h9.2a1 1 0 001-.8L20 8H6" /><circle cx="9" cy="20" r="1.3" /><circle cx="17" cy="20" r="1.3" /></>,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.6-6 7-6s6.2 2.4 7 6" /></>,
  trend: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  plug: <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 01-12 0z" /><path d="M12 17v4" /></>,
  wallet: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18" /><path d="M16 15h2" /><path d="M6 6l9-3 1 3" /></>,
  cog: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3" /></>,
  bolt: <><path d="M13 2.5L4.5 13.5H12L11 21.5l8.5-11H12z" /></>,
  pulse: <><path d="M2.5 12h4l2.5-6 4 12 2.5-6h6" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20.5 20.5L16 16" /></>,
  "arrow-right": <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  close: <><path d="M6 6l12 12M18 6L6 18" /></>,
  lock: <><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 018 0v3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
  shield: <><path d="M12 3l8 3v6c0 4.5-3.4 8.1-8 9-4.6-.9-8-4.5-8-9V6z" /><path d="M8.5 12l2.4 2.4 4.6-4.6" /></>,
  alert: <><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.5M12 17.5v.01" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>,
  pause: <><rect x="6.5" y="5" width="3.5" height="14" rx="1" /><rect x="14" y="5" width="3.5" height="14" rx="1" /></>,
  play: <><path d="M7 4.5v15l12-7.5z" /></>,
};

export function Icon({ name, className = "h-4 w-4", strokeWidth = 1.6 }: { name: IconName; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
      {P[name]}
    </svg>
  );
}
