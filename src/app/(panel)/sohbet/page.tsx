import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { chatHistory } from "@/lib/orchestrator/projects";
import { q } from "@/lib/db/pool";
import { sendInstructionAction } from "@/app/actions";
import { AutoRefresh, IdempotencyField, SubmitButton } from "@/components/client";
import { Badge, DemoBadge, Flash, PageHeader, dt } from "@/components/ui";
import { TASK_STATUS_LABEL, TASK_STATUS_TONE, type TaskStatus } from "@/lib/labels";
import { agentName } from "@/lib/agents/registry";
import { textModelMode } from "@/lib/models";

const EXAMPLES = [
  "Yeni ürünüm için lansman hazırla: strateji, ürün sayfası, görseller, kısa video ve sosyal medya paketi.",
  "Ürün açıklamalarını ve bir lansman koleksiyonunu Shopify için öner.",
  "Önümüzdeki iki hafta için Instagram ve TikTok içerik takvimi hazırla.",
];

export default async function ChatPage({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const messages = await chatHistory(brand.id);
  const activeTasks = await q<{ id: string; title: string; agent: string; status: TaskStatus; project_id: string }>(
    `SELECT t.id, t.title, t.agent, t.status, t.project_id FROM tasks t
     WHERE t.brand_id = $1 AND t.project_id = (SELECT id FROM projects WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 1) ORDER BY t.created_at`,
    [brand.id],
  );
  const running = activeTasks.some((t) => ["planned", "ready", "running", "review_pending"].includes(t.status));
  const mode = textModelMode();
  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1">
        <PageHeader title="Ana yönetici" subtitle={<>Talimatınızı yazın; yönetici görevlere ayırıp uzmanlara dağıtır. Marka: <strong>{brand.name}</strong> · {mode.mode === "demo" ? <DemoBadge /> : mode.mode === "off" ? <Badge tone="warn">AI bağlı değil</Badge> : <Badge tone="ok">Gerçek AI</Badge>}</>} actions={<AutoRefresh active={running} />} />
        <Flash ok={ok} err={err} />
        <div tabIndex={0} className="card mb-4 max-h-[60vh] space-y-3 overflow-y-auto">
          {messages.length === 0 && <p className="muted">Henüz konuşma yok. Aşağıdan ilk talimatınızı verin.</p>}
          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === "user" ? "bg-brand text-white" : "bg-gray-100 text-ink"}`}>
                <div className="mb-1 flex items-center gap-2 text-[11px] opacity-95">
                  {m.role === "user" ? "Siz" : "Ana yönetici"} · {dt(m.created_at)}
                  {m.data?.isDemo && <span className="rounded bg-fuchsia-100 px-1 text-fuchsia-700">DEMO plan</span>}
                </div>
                {m.content}
                {m.project_id && m.role !== "user" && (
                  <div className="mt-2"><Link href={`/projeler/${m.project_id}`} className="text-xs underline">Projeyi aç</Link></div>
                )}
              </div>
            </div>
          ))}
        </div>
        <form action={sendInstructionAction} className="card space-y-2">
          <IdempotencyField />
          <label htmlFor="instruction" className="label">Talimat</label>
          <textarea id="instruction" name="instruction" required rows={4} maxLength={8000} className="input" placeholder="Örn: Yeni ürün için lansman hazırla…" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">Dış platformda yayın, mağaza güncellemesi, fiyat ve reklam işlemleri her zaman onayınızı bekler.</p>
            <SubmitButton pendingText="Gönderiliyor…">Gönder</SubmitButton>
          </div>
        </form>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted">Örnek talimatlar</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">{EXAMPLES.map((e) => <li key={e}>{e}</li>)}</ul>
        </details>
      </div>
      <aside className="w-full lg:w-80">
        <div className="card">
          <h2 className="h2 mb-2">Son proje görevleri</h2>
          {activeTasks.length === 0 ? <p className="muted">Görev yok.</p> : (
            <ul className="space-y-2">
              {activeTasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`/gorevler/${t.id}`} className="min-w-0"><div className="truncate">{t.title}</div><div className="text-xs text-muted">{agentName(t.agent)}</div></Link>
                  <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABEL[t.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
          {activeTasks[0] && <Link href={`/projeler/${activeTasks[0].project_id}`} className="btn mt-3 w-full">Proje ayrıntısı</Link>}
        </div>
      </aside>
    </div>
  );
}
