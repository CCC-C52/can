// Üretim sürümü giriş noktası (GitHub Actions "deploy" işi): npx tsx --tsconfig tsconfig.json scripts/release/deploy.ts
// Girdiler ortam değişkenlerinden okunur; hiçbir gizli değer günlüğe yazılmaz. Çıktılar:
//   release-report.json, GitHub iş özeti (GITHUB_STEP_SUMMARY). Çıkış kodu: 0 = başarılı / kuru çalıştırma hazır / değişiklik yok.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppApi, RenderApi } from "./render-api";
import { reportMarkdown, runRelease, type ReleaseInput } from "./orchestrate";

const env = (k: string) => (process.env[k] ?? "").trim();
const list = (v: string) => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const bool = (v: string) => v === "true" || v === "1" || v === "yes";
const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : d);

const REQUIRED = ["RENDER_API_KEY", "RENDER_WEB_SERVICE_ID", "RENDER_WORKER_SERVICE_ID", "PROD_BASE_URL", "RELEASE_STATUS_TOKEN", "RELEASE_SHA", "PRODUCTION_BRANCH"];

function branchHead(branch: string): string | null {
  try {
    const out = execFileSync("git", ["ls-remote", "origin", `refs/heads/${branch}`], { encoding: "utf8", timeout: 30_000 });
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

async function main() {
  const missing = REQUIRED.filter((k) => !env(k));
  if (missing.length) {
    const msg = `YAPILANDIRMA GEREKİYOR: eksik değerler: ${missing.join(", ")} (gizli değerler: GitHub → Settings → Environments → production; PRODUCTION_BRANCH: Settings → Secrets and variables → Actions → Variables). Dağıtım başlatılmadı.`;
    console.error(msg);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ⛔ Sürüm ENGELLENDİ\n\n${msg}\n`);
    fs.writeFileSync("release-report.json", JSON.stringify({ outcome: "blocked", error: msg, missing }, null, 2));
    process.exit(2);
  }
  const branch = env("RELEASE_BRANCH") || env("GITHUB_REF_NAME");
  const input: ReleaseInput = {
    sha: env("RELEASE_SHA"),
    branch,
    productionBranch: env("PRODUCTION_BRANCH"),
    branchHeadSha: branchHead(branch),
    releaseId: `${env("GITHUB_RUN_ID") || "local"}-${env("GITHUB_RUN_ATTEMPT") || "1"}`,
    ciUrl: env("GITHUB_SERVER_URL") && env("GITHUB_RUN_ID") ? `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}` : undefined,
    ciResult: env("CI_RESULT") || "unknown",
    webServiceId: env("RENDER_WEB_SERVICE_ID"),
    workerServiceId: env("RENDER_WORKER_SERVICE_ID"),
    postgresId: env("RENDER_POSTGRES_ID") || null,
    expectedRepo: env("GITHUB_SERVER_URL") && env("GITHUB_REPOSITORY") ? `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}` : null,
    migrationsDir: path.resolve(process.cwd(), "migrations"),
    authorizeMigrations: list(env("AUTHORIZE_MIGRATIONS")),
    legacyAppliedMigrations: env("LEGACY_APPLIED_MIGRATIONS") ? list(env("LEGACY_APPLIED_MIGRATIONS")) : null,
    allowRedeployFailed: bool(env("ALLOW_REDEPLOY_OF_FAILED")),
    autoRollback: bool(env("AUTO_ROLLBACK")),
    dryRun: bool(env("DRY_RUN")),
    backupMaxAgeHours: num(env("BACKUP_MAX_AGE_HOURS"), 26),
    timeouts: {
      deployMs: num(env("DEPLOY_TIMEOUT_MIN"), 30) * 60_000,
      webHealthMs: num(env("WEB_HEALTH_TIMEOUT_MIN"), 5) * 60_000,
      workerHealthMs: num(env("WORKER_HEALTH_TIMEOUT_MIN"), 8) * 60_000,
      pollMs: num(env("POLL_SECONDS"), 15) * 1000,
    },
  };
  const report = await runRelease(input, {
    render: new RenderApi({ apiKey: env("RENDER_API_KEY"), baseUrl: env("RENDER_API_BASE") || undefined }),
    app: new AppApi({ baseUrl: env("PROD_BASE_URL"), token: env("RELEASE_STATUS_TOKEN") }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (l) => console.log(l),
  });
  fs.writeFileSync("release-report.json", JSON.stringify(report, null, 2));
  const md = reportMarkdown(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  console.log("\n" + md);
  process.exit(["succeeded", "dry_run_ready", "noop"].includes(report.outcome) ? 0 : 1);
}

main().catch((err) => {
  console.error(`Beklenmeyen hata: ${(err as Error).message}`);
  process.exit(1);
});
