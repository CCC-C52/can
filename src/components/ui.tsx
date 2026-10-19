import Link from "next/link";
import type { Tone } from "@/lib/labels";

const TONES: Record<Tone, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  bad: "bg-red-50 text-red-700 ring-red-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  info: "bg-blue-50 text-blue-700 ring-blue-200",
  neutral: "bg-gray-100 text-gray-700 ring-gray-200",
  demo: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
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

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="h1">{title}</h1>
        {subtitle ? <div className="muted mt-1">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line bg-white/60 p-6 text-center text-sm text-muted">{children}</div>;
}

export function Stat({ label, value, hint, href, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; href?: string; tone?: Tone }) {
  const inner = (
    <div className="card h-full">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : ""}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{inner}</Link> : inner;
}

export function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (!ok && !err) return null;
  return (
    <div role="status" className={`mb-4 rounded-lg px-3 py-2 text-sm ${err ? "bg-red-50 text-red-800 ring-1 ring-red-200" : "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200"}`}>
      {err ?? ok}
    </div>
  );
}

export function Unknown() {
  return <span className="italic text-amber-700">Bilinmiyor</span>;
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
