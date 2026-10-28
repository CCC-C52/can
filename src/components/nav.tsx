"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icons";

import { NAV, NAV_GROUPS } from "@/lib/nav";


function isActive(path: string, href: string) {
  if (href === "/") return path === "/";
  if (path === href) return true;
  // Alt sayfası ayrı menü öğesi olan üst sayfa (ör. /pr-ajansi) alt sayfalarda etkin görünmez
  if (!path.startsWith(`${href}/`)) return false;
  return !NAV.some((n) => n.href !== href && n.href.startsWith(`${href}/`) && (path === n.href || path.startsWith(`${n.href}/`)));
}

export function NavLinks({ awaiting = [], onNavigate }: { awaiting?: string[]; onNavigate?: () => void }) {
  const path = usePathname();
  const wait = new Set(awaiting);
  return (
    <div className="space-y-5">
      {NAV_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="eyebrow px-3 pb-1.5 text-[10px]">{g.title}</div>
          <ul className="space-y-0.5">
            {g.items.map((n) => {
              const active = isActive(path, n.href);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    title={n.hint}
                    className={`group relative flex items-center gap-2.5 rounded-xl px-3 py-[7px] text-[13.5px] transition-colors duration-150 ${active ? "bg-brand/12 font-medium text-ink" : "text-ink-soft hover:bg-surface-3 hover:text-ink"}`}
                  >
                    {active && <span aria-hidden="true" className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-brand" />}
                    <Icon name={n.icon} className={`h-[17px] w-[17px] shrink-0 ${active ? "text-brand" : "text-muted group-hover:text-ink-soft"}`} />
                    <span className="truncate">{n.label}</span>
                    {wait.has(n.href) && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Kurulum bekliyor" aria-label="Kurulum bekliyor" role="img" />}
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

/** Mobil/tablet: soldan açılan menü çekmecesi. Alt çubuktaki "Menü" düğmesi de bu çekmeceyi açar. */
export function MobileNav({ awaiting = [], footer }: { awaiting?: string[]; footer?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("aiops:open-nav", onOpen);
    return () => window.removeEventListener("aiops:open-nav", onOpen);
  }, []);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLElement>("a,button")?.focus();
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <>
      <button className="btn h-9 w-9 px-0 lg:hidden" onClick={() => setOpen(true)} aria-expanded={open} aria-controls="mobile-nav" aria-label="Menüyü aç">
        <Icon name="menu" />
      </button>
      {/* Portal: üst çubuktaki backdrop-filter sabit konumlu öğeleri kendi kutusuna hapseder; çekmece body'ye taşınır */}
      {open && createPortal(
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menü">
          <button className="absolute inset-0 bg-black/60 backdrop-blur-sm motion-safe:animate-[rise-in_.2s_ease-out]" aria-label="Menüyü kapat" onClick={() => setOpen(false)} tabIndex={-1} />
          <div id="mobile-nav" ref={panel} className="safe-top safe-bottom absolute inset-y-0 left-0 flex w-[min(20rem,86vw)] flex-col border-r border-line bg-panel shadow-[var(--shadow-pop)]">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="eyebrow">Menü</span>
              <button className="btn h-9 w-9 px-0" onClick={() => setOpen(false)} aria-label="Menüyü kapat"><Icon name="close" /></button>
            </div>
            <nav aria-label="Ana menü" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"><NavLinks awaiting={awaiting} onNavigate={() => setOpen(false)} /></nav>
            {footer ? <div className="border-t border-line p-3">{footer}</div> : null}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Telefon alt çubuğu: en sık kullanılan bölümler + menü. */
export function BottomBar({ approvals }: { approvals: number }) {
  const path = usePathname();
  const items: { href: string; label: string; icon: IconName; badge?: number }[] = [
    { href: "/", label: "Ana ekran", icon: "dashboard" },
    { href: "/sohbet", label: "Yönetici", icon: "spark" },
    { href: "/onaylar", label: "Onaylar", icon: "check", badge: approvals },
    { href: "/gorevler", label: "Görevler", icon: "board" },
  ];
  return (
    <nav aria-label="Hızlı erişim" className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-canvas/90 backdrop-blur-xl md:hidden">
      <ul className="grid grid-cols-5">
        {items.map((i) => {
          const active = isActive(path, i.href);
          return (
            <li key={i.href}>
              <Link href={i.href} aria-current={active ? "page" : undefined} className={`relative flex flex-col items-center gap-0.5 py-2 text-[11px] ${active ? "text-brand" : "text-muted"}`}>
                <Icon name={i.icon} className="h-5 w-5" />
                {i.label}
                {i.badge ? <span className="absolute top-1 right-[calc(50%-18px)] min-w-4 rounded-full bg-brand px-1 text-center text-[10px] leading-4 font-semibold text-on-brand">{i.badge > 99 ? "99+" : i.badge}</span> : null}
              </Link>
            </li>
          );
        })}
        <li>
          <button type="button" onClick={() => window.dispatchEvent(new Event("aiops:open-nav"))} className="flex w-full flex-col items-center gap-0.5 py-2 text-[11px] text-muted">
            <Icon name="menu" className="h-5 w-5" />Menü
          </button>
        </li>
      </ul>
    </nav>
  );
}

/** Hızlı git: menü bölümlerinde arama (Ctrl/⌘+K veya "/"). Yalnızca gezinme; veri aramaz. */
export function QuickNav() {
  const router = useRouter();
  const [qv, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const norm = (s: string) => s.toLocaleLowerCase("tr-TR");
  const matches = useMemo(() => {
    const t = norm(qv.trim());
    if (!t) return [];
    return NAV.filter((n) => norm(n.label).includes(t) || norm(n.hint ?? "").includes(t)).slice(0, 8);
  }, [qv]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const go = (href: string) => { setQ(""); setOpen(false); input.current?.blur(); router.push(href); };
  return (
    <div className="relative w-full max-w-sm">
      <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        ref={input}
        value={qv}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setIdx(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && matches[idx]) { e.preventDefault(); go(matches[idx].href); }
          else if (e.key === "Escape") { setQ(""); setOpen(false); }
        }}
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && matches[idx] ? `${listId}-${idx}` : undefined}
        aria-autocomplete="list"
        aria-label="Bölüm ara"
        placeholder="Bölüm ara…  (Ctrl K)"
        className="input h-9 rounded-full bg-surface-2/80 py-1.5 pr-3 pl-9"
      />
      {open && matches.length > 0 && (
        <ul id={listId} role="listbox" aria-label="Eşleşen bölümler" className="absolute top-11 right-0 left-0 z-50 overflow-hidden rounded-2xl border border-line bg-panel p-1 shadow-[var(--shadow-pop)]">
          {matches.map((m, i) => (
            <li key={m.href} id={`${listId}-${i}`} role="option" aria-selected={i === idx}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); go(m.href); }} className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm ${i === idx ? "bg-surface-3 text-ink" : "text-ink-soft"}`}>
                <Icon name={m.icon} className="h-4 w-4 text-muted" />{m.label}{m.hint ? <span className="ml-auto text-xs text-muted">{m.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
