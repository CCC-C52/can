import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { pendingApprovals } from "@/lib/services/outputs";
import { listExternalActions } from "@/lib/services/gateway";
import { q } from "@/lib/db/pool";
import { agentName } from "@/lib/agents/registry";
import { APPROVAL_SCOPE_LABEL, EXTERNAL_ACTION_STATUS_LABEL } from "@/lib/labels";
import { Badge, DemoBadge, Empty, Flash, PageHeader, dt } from "@/components/ui";
import { reconcileAction_ } from "@/app/actions";

export default async function Approvals({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const [pending, actions, decisions] = await Promise.all([
    pendingApprovals(brand.id),
    listExternalActions(brand.id, 50),
    q<{ id: string; decision: string; scopes: string[]; created_at: string; title: string; output_id: string; version: number; revoked_at: string | null }>(
      `SELECT a.id, a.decision, a.scopes, a.created_at, a.revoked_at, o.title, o.id AS output_id, v.version FROM approvals a JOIN outputs o ON o.id = a.output_id JOIN output_versions v ON v.id = a.output_version_id WHERE a.brand_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [brand.id]),
  ]);
  return (
    <div>
      <PageHeader title="Onay merkezi" subtitle="Dış platformda yayın, canlı mağaza güncellemesi, fiyat/indirim ve reklam işlemleri onayınız olmadan yapılamaz. Bu kural sunucu kodunda uygulanır." />
      <Flash ok={ok} err={err} />
      <section className="card mb-4">
        <h2 className="h2 mb-2">Karar bekleyen çıktılar ({pending.length})</h2>
        {pending.length === 0 ? <Empty>Bekleyen yok.</Empty> : (
          <ul className="divide-y divide-line">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div><Link href={`/taslaklar/${p.id}`} className="font-medium text-brand underline">{p.title}</Link> <span className="text-xs text-muted">v{p.version} · {agentName(p.agent)}</span></div>
                <span className="flex gap-1">{p.is_demo && <DemoBadge />}{p.task_status === "approval_pending" && <Badge tone="warn">Dış işlem önerisi</Badge>}{p.verdict && <Badge tone={p.verdict === "pass" ? "ok" : "bad"}>QA {p.verdict}</Badge>}<Link href={`/taslaklar/${p.id}`} className="btn px-2 py-1 text-xs">İncele</Link></span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="h2 mb-2">Dış işlemler</h2>
          {actions.length === 0 ? <p className="muted">Henüz dış işlem yok.</p> : (
            <ul className="space-y-2 text-sm">
              {actions.map((a) => (
                <li key={a.id} className="rounded-lg bg-surface-2 p-2">
                  <div className="flex flex-wrap items-center gap-1"><Badge tone={a.status === "succeeded" ? "ok" : a.status === "failed" ? "bad" : "warn"}>{EXTERNAL_ACTION_STATUS_LABEL[a.status] ?? a.status}</Badge> {a.action_type} → {a.provider}</div>
                  <div className="text-xs text-muted">{dt(a.created_at)}</div>
                  {a.error && <div className="text-xs text-danger">{a.error}</div>}
                  {a.status === "manual_export" && <a href={`/api/exports/${a.id}`} className="text-xs text-brand underline">Paketi indir</a>}
                  {a.status === "unknown" && (
                    <form action={reconcileAction_} className="mt-1 flex flex-wrap items-center gap-1 text-xs"><input type="hidden" name="actionId" value={a.id} /><input type="hidden" name="back" value="/onaylar" />Platformda kontrol ettim:
                      <button name="outcome" value="succeeded" className="btn px-2 py-0.5 text-xs">Gerçekleşti</button><button name="outcome" value="failed" className="btn px-2 py-0.5 text-xs">Gerçekleşmedi</button></form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Karar geçmişi</h2>
          <ul className="space-y-1 text-sm">
            {decisions.map((d) => (
              <li key={d.id}><Badge tone={d.revoked_at ? "neutral" : d.decision === "approved" ? "ok" : "bad"}>{d.revoked_at ? "Geri alındı" : d.decision === "approved" ? "Onay" : "Ret"}</Badge> <Link href={`/taslaklar/${d.output_id}?v=${d.version}`} className="text-brand underline">{d.title} v{d.version}</Link> <span className="text-xs text-muted">{dt(d.created_at)} · {d.scopes.map((s) => APPROVAL_SCOPE_LABEL[s] ?? s).join(", ")}</span></li>
            ))}
            {decisions.length === 0 && <li className="muted">Henüz karar yok.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
