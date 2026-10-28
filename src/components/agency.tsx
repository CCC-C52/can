import Link from "next/link";
import { Badge, StatusDot } from "@/components/ui";
import { Icon } from "@/components/icons";
import { specialistReadiness, type Specialist } from "@/lib/pr-agency/specialists";
import { STATE_LABEL, STATE_TONE, integrationDef, type IntegrationState } from "@/lib/integrations/registry";
import { agentName } from "@/lib/agents/registry";
import { EVIDENCE_LABEL } from "@/lib/orchestrator/verification";

const READY_LABEL = { ready: "Hazır", partial: "Kısmi veriyle çalışıyor", internal_only: "Yalnızca iç verilerle çalışıyor" } as const;

/** Uzman kartı: görev, mevcut ajan eşlemesi, gereken platformlar ve kanıt kuralı. */
export function SpecialistCard({ s, states }: { s: Specialist; states: Map<string, IntegrationState> }) {
  const verified = new Set([...states].filter(([, v]) => v === "verified" || v === "degraded").map(([k]) => k));
  const r = specialistReadiness(s, verified);
  return (
    <section className="card" aria-labelledby={`sp-${s.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div lang="en" className="eyebrow mb-1">{s.title}</div>
          <h2 id={`sp-${s.id}`} className="font-display text-xl leading-snug">{s.titleTr}</h2>
        </div>
        <Badge tone={r.state === "ready" ? "ok" : r.state === "partial" ? "info" : "warn"}>{READY_LABEL[r.state]}</Badge>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.mission}</p>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="label">Görev motorundaki ajanlar</dt><dd className="text-ink-soft">{s.engineAgents.length ? s.engineAgents.map((a) => agentName(a)).join(", ") : "Zamanlanmış işler"}</dd></div>
        <div><dt className="label">Gereken kanıt</dt><dd className="text-ink-soft">{s.evidence}</dd></div>
        <div>
          <dt className="label">Platformlar</dt>
          <dd className="space-y-1">
            {s.integrations.length === 0 ? <span className="text-ink-soft">Gerekmiyor</span> : s.integrations.map((i) => {
              const st = states.get(i) ?? "not_configured";
              return <div key={i} className="flex items-center gap-1.5 text-ink-soft"><StatusDot tone={STATE_TONE[st]} />{integrationDef(i)?.name.split(" (")[0]}: <span className="text-muted">{STATE_LABEL[st]}</span></div>;
            })}
          </dd>
        </div>
      </dl>
      {r.missing.length > 0 && (
        <Link href="/entegrasyonlar" className="mt-3 inline-flex items-center gap-1 text-sm text-brand hover:text-brand-strong">Eksik platformları bağla<Icon name="arrow-right" className="h-3.5 w-3.5" /></Link>
      )}
    </section>
  );
}

export function EvidenceRule({ kind }: { kind: keyof typeof EVIDENCE_LABEL }) {
  return (
    <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-xs text-ink-soft">
      <Icon name="shield" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
      <span>Başarı ancak kanıtla sayılır: <strong className="text-ink">{EVIDENCE_LABEL[kind]}</strong>. Metin yanıtı, JSON veya plan, dış işlemin gerçekleştiğinin kanıtı değildir.</span>
    </p>
  );
}
