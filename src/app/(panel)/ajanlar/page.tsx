import { AGENTS, TOOLS } from "@/lib/agents/registry";
import { OUTPUT_SCHEMAS } from "@/lib/agents/schemas";
import { toStrictJsonSchema } from "@/lib/models/anthropic";
import { PageHeader, Badge } from "@/components/ui";
import { textModelMode } from "@/lib/models";

export default function AgentsPage() {
  const mode = textModelMode();
  return (
    <div>
      <PageHeader title="Ajanlar" subtitle={<>Uygulamanın çalışma zamanı ekibi. {mode.label}.</>} />
      <div className="grid gap-4 lg:grid-cols-2">
        {Object.values(AGENTS).map((a) => (
          <section key={a.id} className="card space-y-2 text-sm">
            <div className="flex items-center justify-between"><h2 className="h2">{a.name}</h2>{a.producesExternalProposal && <Badge tone="warn">Çıktısı onay gerektirir</Badge>}</div>
            <p>{a.role}</p>
            <div><div className="label">Görevler</div><ul className="list-disc pl-5">{a.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul></div>
            <div><div className="label">Gerekli girdiler</div><p>{a.requiredInputs.join(" · ")}</p></div>
            <div><div className="label">Çıktı</div><p>{a.outputDescription}</p></div>
            <div><div className="label">Araç izinleri (sunucuda zorunlu)</div><ul className="text-xs">{a.tools.map((t) => <li key={t}><code>{t}</code> — {TOOLS[t]}</li>)}</ul></div>
            <div><div className="label">Teslim ölçütleri</div><ul className="list-disc pl-5 text-xs">{a.acceptanceCriteria.map((c) => <li key={c}>{c}</li>)}</ul></div>
            {a.id in OUTPUT_SCHEMAS && (
              <details><summary className="cursor-pointer text-xs text-brand">Yapılandırılmış çıktı şeması</summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded bg-gray-50 p-2 text-[11px]">{JSON.stringify(toStrictJsonSchema((OUTPUT_SCHEMAS as any)[a.id]), null, 2)}</pre></details>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
