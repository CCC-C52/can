import crypto from "node:crypto";
import { FOLDER_MIME } from "@/lib/drive/google";

// Sahte Google (OAuth + Drive v3, salt okunur uç noktalar). Gerçek Google'a hiçbir istek gitmez.
// Brand Brain testleri için: içerik indirme (alt=media), Google Dokümanı/Slayt düz metin ve E-Tablo XLSX dışa aktarımı,
// değişiklik akışı (changes), hata enjeksiyonu (429/500/404).

export type FakeFile = {
  id: string; name: string; mimeType: string; parents: string[]; trashed?: boolean; content?: Buffer; exportXlsx?: Buffer;
  width?: number; height?: number; durationMs?: number; version?: number; modified?: string;
};

export const TOKEN = "ya29.fake-brain-access-token";
export const REFRESH = "1//fake-brain-refresh-token-abcdef";

export class FakeDrive {
  files = new Map<string, FakeFile>();
  changes: { fileId: string; removed?: boolean }[] = [];
  pageSize = 50;
  calls: string[] = [];
  /** Dosya kimliği → sonraki N indirmede dönecek HTTP durumu (ör. 500, 429). */
  failDownloads = new Map<string, { status: number; times: number }>();
  private seq = 0;

  id(prefix: string) { return `${prefix}${String(++this.seq).padStart(14, "0")}`; }

  put(f: FakeFile, logChange = true) {
    this.files.set(f.id, { version: 1, modified: "2026-02-01T00:00:00.000Z", ...f });
    if (logChange) this.changes.push({ fileId: f.id });
    return this.files.get(f.id)!;
  }

  /** İçeriği değiştirir: sürüm ve değişiklik zamanı ilerler, değişiklik akışına yazılır. */
  update(id: string, patch: Partial<FakeFile>) {
    const f = this.files.get(id)!;
    const v = (f.version ?? 1) + 1;
    this.files.set(id, { ...f, ...patch, version: v, modified: new Date(Date.parse(f.modified ?? "2026-02-01T00:00:00.000Z") + 86_400_000).toISOString() });
    this.changes.push({ fileId: id });
  }

  trash(id: string) {
    this.files.set(id, { ...this.files.get(id)!, trashed: true });
    this.changes.push({ fileId: id });
  }

  private native(f: FakeFile) { return f.mimeType.startsWith("application/vnd.google-apps."); }

  fileJson(f: FakeFile) {
    const md5 = f.content && !this.native(f) ? crypto.createHash("md5").update(f.content).digest("hex") : undefined;
    return {
      id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, trashed: !!f.trashed,
      ...(f.content && !this.native(f) ? { size: String(f.content.length), md5Checksum: md5 } : {}),
      createdTime: "2026-01-01T00:00:00.000Z", modifiedTime: f.modified, version: String(f.version ?? 1), hasThumbnail: f.mimeType.startsWith("image/"),
      ...(f.width ? { imageMediaMetadata: { width: f.width, height: f.height } } : {}),
      ...(f.durationMs ? { videoMediaMetadata: { durationMillis: String(f.durationMs) } } : {}),
    };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    this.calls.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}${url.searchParams.get("alt") ? "?alt=media" : ""}`);
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      const p = new URLSearchParams(String(init?.body));
      return json(200, { access_token: TOKEN, expires_in: 3600, scope: "https://www.googleapis.com/auth/drive.readonly", ...(p.get("grant_type") === "authorization_code" ? { refresh_token: REFRESH } : {}) });
    }
    if (url.hostname !== "www.googleapis.com") return new Response("unexpected host", { status: 599 });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) return json(401, { error: { status: "UNAUTHENTICATED" } });
    const path = url.pathname.replace("/drive/v3", "");
    const sp = url.searchParams;
    if (path === "/about") return json(200, { user: { emailAddress: "owner@fribee.test" } });
    if (path === "/changes/startPageToken") return json(200, { startPageToken: String(this.changes.length) });
    if (path === "/changes") {
      const from = Number(sp.get("pageToken"));
      const page = this.changes.slice(from, from + this.pageSize);
      const next = from + page.length;
      const changes = page.map((c) => { const f = this.files.get(c.fileId); return c.removed || !f ? { fileId: c.fileId, removed: true } : { fileId: c.fileId, removed: false, file: this.fileJson(f) }; });
      return json(200, next < this.changes.length ? { changes, nextPageToken: String(next) } : { changes, newStartPageToken: String(next) });
    }
    if (path === "/files") {
      const query = sp.get("q") ?? "";
      const byName = /^name = '(.+)' and mimeType/.exec(query);
      if (byName) return json(200, { files: [...this.files.values()].filter((f) => f.name === byName[1] && f.mimeType === FOLDER_MIME && !f.trashed).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modified, owners: [{ displayName: "Owner" }] })) });
      const parent = /^'([A-Za-z0-9_-]+)' in parents/.exec(query)![1];
      const all = [...this.files.values()].filter((f) => f.parents.includes(parent) && !f.trashed).sort((a, b) => a.id.localeCompare(b.id));
      const from = Number(sp.get("pageToken") ?? 0);
      const page = all.slice(from, from + this.pageSize);
      return json(200, { files: page.map((f) => this.fileJson(f)), ...(from + this.pageSize < all.length ? { nextPageToken: String(from + this.pageSize) } : {}) });
    }
    const m = /^\/files\/([A-Za-z0-9_-]+)(\/export)?$/.exec(path);
    if (m) {
      const f = this.files.get(m[1]);
      if (!f || f.trashed) return json(404, { error: { errors: [{ reason: "notFound" }] } });
      const fail = this.failDownloads.get(f.id);
      if (fail && fail.times > 0 && (m[2] || sp.get("alt") === "media")) {
        fail.times--;
        return json(fail.status, { error: { errors: [{ reason: fail.status === 429 ? "rateLimitExceeded" : "backendError" }] } });
      }
      if (m[2]) {
        const mime = sp.get("mimeType");
        if (mime === "text/plain") return new Response(new Uint8Array(f.content ?? Buffer.alloc(0)), { status: 200, headers: { "content-type": "text/plain" } });
        if (mime?.includes("spreadsheetml") && f.exportXlsx) return new Response(new Uint8Array(f.exportXlsx), { status: 200 });
        return json(400, { error: { errors: [{ reason: "badRequest" }] } });
      }
      if (sp.get("alt") === "media") return new Response(new Uint8Array(f.content!), { status: 200, headers: { "content-length": String(f.content!.length) } });
      return json(200, this.fileJson(f));
    }
    return json(404, { error: { errors: [{ reason: "notFound" }] } });
  };
}
