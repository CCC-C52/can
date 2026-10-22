// Render API istemcisi (resmi REST API, https://api.render.com/v1). Uç ve alan adları Render'ın resmi CLI'sinin
// OpenAPI'den üretilmiş istemcisiyle doğrulandı (render-oss/cli, pkg/client).
// - Geçici hatalarda (429, 5xx, ağ, zaman aşımı) sınırlı ve artan beklemeli yeniden deneme; diğer 4xx'te deneme yok.
// - API anahtarı yalnızca Authorization başlığında; hata mesajlarına istek gövdesi veya başlık yazılmaz.

export type Fetch = typeof fetch;
export type Sleep = (ms: number) => Promise<void>;

export const TERMINAL_OK = new Set(["live"]);
export const TERMINAL_FAIL = new Set(["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"]);

export type RenderDeploy = {
  id: string;
  status?: string;
  commit?: { id?: string; message?: string; createdAt?: string };
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  trigger?: string;
};
export type RenderService = {
  id: string;
  name: string;
  type?: string;
  repo?: string;
  branch?: string;
  autoDeploy?: "yes" | "no";
  autoDeployTrigger?: "off" | "commit" | "checksPass";
  suspended?: "suspended" | "not_suspended";
};
export type RecoveryInfo = { recoveryStatus: "AVAILABLE" | "BACKUP_NOT_READY" | "NOT_AVAILABLE"; startsAt?: string };

export class ApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
  }
}

export class RenderApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly sleep: Sleep;
  constructor(private readonly o: { apiKey: string; baseUrl?: string; fetchImpl?: Fetch; sleep?: Sleep; maxRetries?: number; timeoutMs?: number }) {
    if (!o.apiKey) throw new Error("RENDER_API_KEY tanımlı değil.");
    this.baseUrl = (o.baseUrl ?? "https://api.render.com/v1").replace(/\/+$/, "");
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { retry?: boolean } = {}): Promise<T> {
    const max = opts.retry === false ? 0 : this.o.maxRetries ?? 4;
    let last: ApiError | null = null;
    for (let attempt = 0; attempt <= max; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(30_000, 1000 * 2 ** attempt));
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.o.apiKey}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
        });
      } catch (err) {
        last = new ApiError(`Render API'ye ulaşılamadı (${method} ${path.split("/").slice(0, 2).join("/")}): ${(err as Error).name}`, null, true);
        continue;
      }
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      const retryable = res.status === 429 || res.status >= 500;
      last = new ApiError(`Render API ${res.status} (${method} ${path.replace(/\/(srv|dpg|dep|crn)-[a-z0-9]+/g, "/$1-…")})`, res.status, retryable);
      if (!retryable) throw last;
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) await this.sleep(Math.min(60_000, ra * 1000));
    }
    throw last ?? new ApiError("Render API: bilinmeyen hata", null, false);
  }

  getService(id: string) {
    return this.req<RenderService>("GET", `/services/${encodeURIComponent(id)}`);
  }

  async listDeploys(id: string, limit = 20): Promise<RenderDeploy[]> {
    const rows = await this.req<{ deploy?: RenderDeploy }[]>("GET", `/services/${encodeURIComponent(id)}/deploys?limit=${limit}`);
    return (rows ?? []).map((r) => r.deploy).filter((d): d is RenderDeploy => !!d);
  }

  getDeploy(id: string, deployId: string) {
    return this.req<RenderDeploy>("GET", `/services/${encodeURIComponent(id)}/deploys/${encodeURIComponent(deployId)}`);
  }

  /**
   * Belirli commit için dağıtım başlatır. POST yeniden denenmez (çift dağıtım riski); geçici hatada önce aynı commit
   * için az önce oluşmuş bir dağıtım var mı bakılır, yoksa bir kez daha denenir.
   */
  async createDeploy(id: string, commitId: string, since: Date): Promise<RenderDeploy> {
    const body = { commitId, clearCache: "do_not_clear" };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.req<RenderDeploy>("POST", `/services/${encodeURIComponent(id)}/deploys`, body, { retry: false });
      } catch (err) {
        if (!(err instanceof ApiError) || !err.retryable) throw err;
        await this.sleep(5000 * (attempt + 1));
        const existing = (await this.listDeploys(id, 10)).find((d) => d.commit?.id === commitId && d.createdAt && new Date(d.createdAt) >= since);
        if (existing) return existing;
      }
    }
    throw new ApiError("Render dağıtımı başlatılamadı (geçici hatalar sürdü).", null, true);
  }

  cancelDeploy(id: string, deployId: string) {
    return this.req<RenderDeploy>("POST", `/services/${encodeURIComponent(id)}/deploys/${encodeURIComponent(deployId)}/cancel`, undefined, { retry: false });
  }

  rollback(id: string, deployId: string) {
    return this.req<RenderDeploy>("POST", `/services/${encodeURIComponent(id)}/rollback`, { deployId }, { retry: false });
  }

  postgresRecovery(postgresId: string) {
    return this.req<RecoveryInfo>("GET", `/postgres/${encodeURIComponent(postgresId)}/recovery`);
  }
}

// ---------------------------------------------------------------- Uygulamanın sürüm uçları

export type AppStatus = {
  ok: boolean;
  commit: string | null;
  db: { ok: boolean };
  migrations?: { applied: string[]; inImage: string[]; pending: string[] };
  workers?: { commit: string | null; ageSeconds: number; live: boolean }[];
  paused?: boolean;
  backup?: { lastOk: { at: string; dbBytes: number | null } | null; last: { at: string; ok: boolean } | null };
  releases?: { releaseId: string; sha: string; outcome: string }[];
};

export type StatusResult = { kind: "ok"; data: AppStatus } | { kind: "disabled" } | { kind: "unauthorized" } | { kind: "error"; detail: string };

export class AppApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  constructor(private readonly o: { baseUrl: string; token: string; fetchImpl?: Fetch; timeoutMs?: number }) {
    if (!o.baseUrl) throw new Error("PROD_BASE_URL tanımlı değil.");
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async health(): Promise<{ ok: boolean; status: number | null }> {
    try {
      const r = await this.fetchImpl(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000), headers: { "cache-control": "no-cache" } });
      const body = await r.json().catch(() => null);
      return { ok: r.status === 200 && body?.ok === true, status: r.status };
    } catch {
      return { ok: false, status: null };
    }
  }

  async status(): Promise<StatusResult> {
    try {
      const r = await this.fetchImpl(`${this.baseUrl}/api/release/status`, { headers: { authorization: `Bearer ${this.o.token}` }, signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
      if (r.status === 404) return { kind: "disabled" };
      if (r.status === 401) return { kind: "unauthorized" };
      const data = (await r.json().catch(() => null)) as AppStatus | null;
      if (!data) return { kind: "error", detail: `durum ${r.status}` };
      return { kind: "ok", data };
    } catch (err) {
      return { kind: "error", detail: (err as Error).name };
    }
  }

  /** Sürüm olayını panele bildirir. Hata dağıtımı durdurmaz (yalnızca kayıt). */
  async event(e: Record<string, unknown>): Promise<boolean> {
    try {
      const r = await this.fetchImpl(`${this.baseUrl}/api/release/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" },
        body: JSON.stringify(e),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }
}
