"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";

// Sesli uyarı: açıkken panel 15 sn'de bir biten görevleri sorar; görev onaya düştüğünde, tamamlandığında veya
// başarısız olduğunda ses çalar, sayfada kısa bir not gösterir ve izin verildiyse bilgisayar bildirimi çıkarır.
// Tarayıcılar sesi ancak bir tıklamadan sonra çalar: düğmeye basmak sesi açar; sayfa yenilenince ilk tıklamada yeniden açılır.
// Panel sekmesi açık olmalıdır (arka planda olabilir; tarayıcı sorguyu dakikada bire kadar seyreltebilir).

type Alert = { id: string; title: string; agent: string; label: string; ok: boolean; finished_at: string };

const KEY = "aiops:task-alerts";
const POLL_MS = 15_000;

function stored() {
  try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
}
function store(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* gizli pencere: yalnızca bu oturum */ }
}

/** Kısa zil: başarıda yükselen üç nota, hatada inen iki nota. Dosya gerekmez (Web Audio). */
function chime(ctx: AudioContext, ok: boolean) {
  let t = ctx.currentTime + 0.02;
  for (const f of ok ? [660, 880, 1320] : [520, 390, 290]) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = ok ? "sine" : "triangle";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.5);
    t += 0.2;
  }
}

export function TaskAlerts() {
  const [on, setOn] = useState(false);
  const [toasts, setToasts] = useState<Alert[]>([]);
  const audio = useRef<AudioContext | null>(null);
  const since = useRef<string | null>(null);
  const seen = useRef(new Set<string>());

  const unlock = useCallback(() => {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    audio.current ??= new AC();
    if (audio.current.state === "suspended") void audio.current.resume().catch(() => {});
  }, []);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); if (stored()) setOn(true); }, []);

  // Sayfa yenilendiyse ses ilk tıklamada yeniden açılır
  useEffect(() => {
    if (!on) return;
    const h = () => unlock();
    window.addEventListener("pointerdown", h, { once: true });
    window.addEventListener("keydown", h, { once: true });
    return () => { window.removeEventListener("pointerdown", h); window.removeEventListener("keydown", h); };
  }, [on, unlock]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/activity${since.current ? `?since=${encodeURIComponent(since.current)}` : ""}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { now: string; events: Alert[] };
      const fresh = body.events.filter((e) => !seen.current.has(`${e.id}:${e.finished_at}`));
      since.current = body.now;
      if (!fresh.length) return;
      for (const e of fresh) seen.current.add(`${e.id}:${e.finished_at}`);
      if (seen.current.size > 500) seen.current = new Set([...seen.current].slice(-200));
      if (audio.current && audio.current.state === "running") chime(audio.current, fresh.every((e) => e.ok));
      if ("Notification" in window && Notification.permission === "granted") {
        for (const e of fresh.slice(0, 3)) {
          try { new Notification(`${e.label}: ${e.title}`, { body: e.agent, tag: e.id }); } catch { /* bazı mobil tarayıcılar desteklemez */ }
        }
      }
      setToasts((t) => [...fresh, ...t].slice(0, 4));
      setTimeout(() => setToasts((t) => t.filter((x) => !fresh.includes(x))), 15_000);
    } catch { /* ağ hatası: bir sonraki sorguda */ }
  }, []);

  useEffect(() => {
    if (!on) return;
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    const vis = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [on, poll]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    store(next);
    if (next) {
      unlock();
      if (audio.current) chime(audio.current, true); // deneme sesi: duyuluyorsa çalışıyor
      if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {});
    } else {
      since.current = null;
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={on}
        aria-label={on ? "Sesli uyarılar açık (kapatmak için basın)" : "Sesli uyarıları aç: görev bitince ses ve bildirim"}
        title={on ? "Sesli uyarılar açık" : "Görev bitince sesli uyarı"}
        className={`btn relative h-9 w-9 px-0 ${on ? "text-brand ring-1 ring-brand/25" : ""}`}
      >
        <Icon name="bell" />
        {on && <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-brand" />}
      </button>
      {/* Üst çubuk backdrop-filter kullandığı için "fixed" orada çubuğa göre konumlanır: notlar body'ye taşınır */}
      {mounted && createPortal(
      <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-24 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 md:bottom-6">
        {toasts.map((e) => (
          <Link key={`${e.id}:${e.finished_at}`} href={`/gorevler/${e.id}`} className={`card pointer-events-auto block p-3 text-sm ring-1 ${e.ok ? "ring-success-line" : "ring-danger-line"}`}>
            <span className={`font-semibold ${e.ok ? "text-success" : "text-danger"}`}>{e.label}</span>
            <span className="block truncate text-ink">{e.title}</span>
            <span className="block text-xs text-muted">{e.agent}</span>
          </Link>
        ))}
      </div>,
      document.body)}
    </>
  );
}
