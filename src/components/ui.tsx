import Link from "next/link";
import type { Tone } from "@/lib/labels";
import { Icon, type IconName } from "@/components/icons";

const TONES: Record<Tone, string> = {
  ok: "bg-success-soft text-success ring-success-line",
  bad: "bg-danger-soft text-danger ring-danger-line",
  warn: "bg-warning-soft text-warning ring-warning-line",
  info: "bg-info-soft text-info ring-info-line",
  neutral: "bg-surface-3 text-ink-soft ring-line",
  demo: "bg-demo-soft text-demo ring-demo-line",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function DemoBadge() {
  return <Badge tone="demo" title="Kural tabanlı demo şablonu — gerçek AI üretimi değildir">DEMO</Badge>;
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
        <h1 className="h1">{title}</h1>
        {subtitle ? <div className="muted mt-2 leading-relaxed">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Empty({ children, icon = "layers" }: { children: React.ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line bg-panel/60 p-6 text-center text-sm text-muted">
      <Icon name={icon} className="h-5 w-5 text-muted/80" />
      <div>{children}</div>
    </div>
  );
}

const ACCENT = {
  gold: "text-brand bg-brand/10 ring-brand/25",
  violet: "text-violet bg-violet/10 ring-violet/25",
  sky: "text-sky bg-sky/10 ring-sky/25",
  ember: "text-ember bg-ember/10 ring-ember/25",
  mint: "text-mint bg-mint/10 ring-mint/25",
} as const;
export type Accent = keyof typeof ACCENT;

export function Stat({ label, value, hint, href, tone, icon, accent = "gold" }: { label: string; value: React.ReactNode; hint?: React.ReactNode; href?: string; tone?: Tone; icon?: IconName; accent?: Accent }) {
  const inner = (
    <div className={`card h-full ${href ? "card-interactive" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-muted">{label}</div>
        {icon ? <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ring-1 ring-inset ${ACCENT[accent]}`}><Icon name={icon} /></span> : null}
      </div>
      <div className={`mt-2 text-[1.65rem] leading-none font-semibold tracking-tight ${tone === "bad" ? "text-danger" : tone === "warn" ? "text-warning" : "text-ink"}`}>{value}</div>
      {hint ? <div className="mt-2 text-xs leading-relaxed text-muted">{hint}</div> : null}
    </div>
  );
  return href ? <Link href={href} className="block rounded-[var(--radius-card)]">{inner}</Link> : inner;
}

/** Başlıklı kart: başlık, isteğe bağlı üst başlık ve sağda bağlantı. */
export function Section({ title, eyebrow, href, linkLabel = "Tümü", children, className = "", id }: { title: string; eyebrow?: string; href?: string; linkLabel?: string; children: React.ReactNode; className?: string; id?: string }) {
  const hid = id ? `${id}-title` : undefined;
  return (
    <section className={`card ${className}`} aria-labelledby={hid}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow ? <div className="eyebrow mb-1">{eyebrow}</div> : null}
          <h2 id={hid} className="h2">{title}</h2>
        </div>
        {href ? <Link href={href} className="inline-flex shrink-0 items-center gap-1 text-sm text-brand hover:text-brand-strong">{linkLabel}<Icon name="arrow-right" className="h-3.5 w-3.5" /></Link> : null}
      </div>
      {children}
    </section>
  );
}

/** Kurulum bekleyen özellik: neyin eksik olduğunu ve nereden bağlanacağını açıkça söyler. Sahte veri göstermez. */
export function AwaitingSetup({ title = "Kurulum bekliyor", children, href, linkLabel = "Entegrasyonlar" }: { title?: string; children: React.ReactNode; href?: string; linkLabel?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface-2/70 p-4 text-sm">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning ring-1 ring-inset ring-warning-line"><Icon name="plug" /></span>
      <div className="min-w-0">
        <div className="font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-muted">{children}</div>
        {href ? <Link href={href} className="mt-2 inline-flex items-center gap-1 text-brand hover:text-brand-strong">{linkLabel}<Icon name="arrow-right" className="h-3.5 w-3.5" /></Link> : null}
      </div>
    </div>
  );
}

export function Progress({ value, max = 100, label, tone = "gold" }: { value: number; max?: number; label: string; tone?: "gold" | "danger" | "warn" | "ok" }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const bar = tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warning" : tone === "ok" ? "bg-success" : "bg-brand";
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value * 100) / 100} className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={`h-full rounded-full ${bar} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function StatusDot({ tone = "neutral", pulse }: { tone?: Tone; pulse?: boolean }) {
  const c = tone === "ok" ? "bg-success" : tone === "bad" ? "bg-danger" : tone === "warn" ? "bg-warning" : tone === "info" ? "bg-info" : tone === "demo" ? "bg-demo" : "bg-muted";
  return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${c} ${pulse ? "motion-safe:animate-pulse" : ""}`} />;
}

export function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (!ok && !err) return null;
  return (
    <div role="status" className={`mb-4 rounded-xl px-3.5 py-2.5 text-sm ${err ? "bg-danger-soft text-danger ring-1 ring-danger-line" : "bg-success-soft text-success ring-1 ring-success-line"}`}>
      {err ?? ok}
    </div>
  );
}

export function Unknown() {
  return <span className="italic text-warning">Bilinmiyor</span>;
}

export function Val({ v }: { v: unknown }) {
  if (v === null || v === undefined || v === "") return <Unknown />;
  return <>{String(v)}</>;
}

export function usd(n: number | null | undefined, digits = 4) {
  if (n === null || n === undefined) return "Bilinmiyor";
  return `$${Number(n).toFixed(digits)}`;
}

export function dt(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
}
