import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { AutoRefresh } from "@/components/client";

export const dynamic = "force-dynamic";

type WorkflowRun = {
  id: number; name: string; status: string; conclusion: string | null;
  html_url: string; created_at: string; head_branch: string | null;
};
type PullRequest = {
  number: number; title: string; html_url: string; draft: boolean;
  updated_at: string; head: { ref: string };
};
type Issue = {
  number: number; title: string; html_url: string;
  pull_request?: unknown; labels: { name: string }[];
};
const REPO = "CCC-C52/can";
const GH = "https://api.github.com/repos/" + REPO;
const headers = { Accept: "application/vnd.github+json", "User-Agent": "FriBee-AI-Operations-Studio" };

async function githubJson<T>(path: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(GH + path, { headers, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { data: null, error: response.status === 403 ? "GitHub API sınırına ulaşıldı veya erişim engellendi." : `GitHub HTTP ${response.status}` };
    return { data: (await response.json()) as T, error: null };
  } catch {
    return { data: null, error: "GitHub'a şu anda ulaşılamıyor." };
  }
}
function state(status: string, conclusion: string | null) {
  if (status !== "completed") return { label: "Çalışıyor / bekliyor", tone: "bg-amber-100 text-amber-900" };
  if (conclusion === "success") return { label: "Başarılı", tone: "bg-emerald-100 text-emerald-900" };
  if (conclusion === "failure") return { label: "Başarısız", tone: "bg-red-100 text-red-900" };
  return { label: conclusion ?? "Bilinmiyor", tone: "bg-gray-100 text-gray-700" };
}
export default async function DevelopmentCenter() {
  const [runs, prs, issues] = await Promise.all([
    githubJson<{ workflow_runs: WorkflowRun[] }>("/actions/runs?per_page=15"),
    githubJson<PullRequest[]>("/pulls?state=open&per_page=15"),
    githubJson<Issue[]>("/issues?state=open&per_page=20"),
  ]);
  const claudeRuns = (runs.data?.workflow_runs ?? []).filter(r => r.name === "FriBee Claude Task");
  const otherRuns = (runs.data?.workflow_runs ?? []).filter(r => r.name !== "FriBee Claude Task").slice(0, 6);
  const tasks = (issues.data ?? []).filter(i => !i.pull_request && i.labels.some(l => l.name === "claude-task"));
  return (
    <div className="space-y-5">
      <PageHeader title="AI Development Center" subtitle="FriBee · GitHub üzerinden Claude Code görevleri, testler ve geliştirme durumları. Claude.ai sohbeti değil, GitHub Actions çalışma ortamı izlenir." actions={<AutoRefresh active />} />
      <section className="card space-y-2">
        <h2 className="h2">Bağlantı durumu</h2>
        <p className="text-sm text-muted">Kaynak: GitHub public repository API. Sayfa otomatik yenilenir; gerçek zamanlı sohbet değildir. API hatası olduğunda önceki veriler başarı gibi gösterilmez.</p>
        <a className="text-brand underline text-sm" href="https://github.com/CCC-C52/can/actions" target="_blank" rel="noopener noreferrer">GitHub Actions günlüklerini aç</a>
        {[runs.error, prs.error, issues.error].filter(Boolean).map((error, index) => <p key={index} className="text-sm text-red-700">{error}</p>)}
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-3">
          <h2 className="h2">Claude görevleri</h2>
          {claudeRuns.length === 0 ? <p className="text-sm text-muted">Görev kaydı bulunamadı veya GitHub API erişilemiyor.</p> :
            <ul className="space-y-3">{claudeRuns.slice(0, 8).map(run => {
              const s = state(run.status, run.conclusion);
              return <li key={run.id} className="border-b border-line pb-2 text-sm">
                <div className="flex items-center justify-between gap-2"><a href={run.html_url} target="_blank" rel="noopener noreferrer" className="text-brand underline">Claude çalıştırması #{run.id}</a><span className={`rounded px-2 py-1 text-xs ${s.tone}`}>{s.label}</span></div>
                <p className="text-xs text-muted">{run.head_branch ?? "Bilinmeyen dal"} · {new Date(run.created_at).toLocaleString("tr-TR")}</p>
              </li>;
            })}</ul>}
        </section>
        <section className="card space-y-3">
          <h2 className="h2">Claude'a gönderilen işler</h2>
          {tasks.length === 0 ? <p className="text-sm text-muted">Etiketli açık görev bulunamadı.</p> :
            <ul className="space-y-2">{tasks.map(issue => <li key={issue.number} className="text-sm"><a className="text-brand underline" href={issue.html_url} target="_blank" rel="noopener noreferrer">#{issue.number} · {issue.title}</a></li>)}</ul>}
          <p className="text-xs text-muted">Yeni görevler yalnızca sahip onayıyla GitHub Issue üzerinden tetiklenir. Bu sayfa görev göndermez veya ücretli çağrı başlatmaz.</p>
        </section>
        <section className="card space-y-3">
          <h2 className="h2">Geliştirme Pull Request'leri</h2>
          {(prs.data ?? []).length === 0 ? <p className="text-sm text-muted">Açık PR bulunamadı.</p> :
            <ul className="space-y-2">{(prs.data ?? []).map(pr => <li key={pr.number} className="text-sm">
              <a href={pr.html_url} target="_blank" rel="noopener noreferrer" className="text-brand underline">#{pr.number} · {pr.title}</a>
              <p className="text-xs text-muted">{pr.draft ? "Taslak · " : ""}{pr.head.ref}</p>
            </li>)}</ul>}
        </section>
        <section className="card space-y-3">
          <h2 className="h2">CI ve Release</h2>
          {otherRuns.length === 0 ? <p className="text-sm text-muted">Test kaydı bulunamadı.</p> :
            <ul className="space-y-2">{otherRuns.map(run => {
              const s = state(run.status, run.conclusion);
              return <li key={run.id} className="flex justify-between gap-2 text-sm"><a className="text-brand underline" href={run.html_url} target="_blank" rel="noopener noreferrer">{run.name} #{run.id}</a><span className={`rounded px-2 py-1 text-xs ${s.tone}`}>{s.label}</span></li>;
            })}</ul>}
        </section>
      </div>
      <p className="text-xs text-muted">Güvenlik: Bu merkez salt okunurdur. API anahtarı, dağıtım veya GitHub yazma işlemi gerçekleştirmez. Depo public olduğu için yalnızca herkese açık GitHub bilgilerini gösterir.</p>
      <Link href="/tanilama" className="text-sm text-brand underline">Sistem Durumu</Link>
    </div>
  );
}
