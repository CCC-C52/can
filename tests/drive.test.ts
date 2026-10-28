import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { getMedia, readMediaFile } from "@/lib/services/media";
import { getConnection } from "@/lib/services/connections";
import { listMemory } from "@/lib/services/brand-memory";
import { buildBrandContext } from "@/lib/agents/context";
import { systemPrompt } from "@/lib/agents/prompts";
import { DRIVE_SCOPES, FOLDER_MIME, driveRuntime } from "@/lib/drive/google";
import { completeDriveOAuth, consumeDriveState, disconnectDrive, findArchiveFolders, getDriveSource, selectArchiveFolder, startDriveOAuth } from "@/lib/drive/source";
import { runDriveScanOnce } from "@/lib/drive/indexer";
import { autoQueueReferences, bulkReview, chunkText, importReferenceOriginal, isNonProductImage, proposeMemoryFromDocument, reviewReference, runReferenceImportOnce, suggestReferences, unverifiedDriveAssetIds } from "@/lib/drive/references";

// Sahte Google (OAuth + Drive v3). Gerçek Google'a hiçbir istek gitmez.
type FakeFile = { id: string; name: string; mimeType: string; parents: string[]; trashed?: boolean; content?: Buffer; width?: number; height?: number; md5Override?: string };

const ROOT = "rootFolderId0001";
const TOKEN = "ya29.fake-access-token-xyz";
const REFRESH = "1//fake-refresh-token-abcdefghij";

const G = {
  files: new Map<string, FakeFile>(),
  changes: [] as { fileId: string; removed?: boolean }[],
  revoked: false,
  grantScope: DRIVE_SCOPES[0] as string,
  pageSize: 3,
  calls: [] as string[],
  onChildrenPage: null as null | (() => Promise<void>),
};

let seq = 0;
const id = (p: string) => `${p}${String(++seq).padStart(12, "0")}`;

function put(f: FakeFile, log = true) {
  G.files.set(f.id, f);
  if (log) G.changes.push({ fileId: f.id });
  return f;
}

function fileJson(f: FakeFile) {
  const md5 = f.md5Override ?? (f.content ? crypto.createHash("md5").update(f.content).digest("hex") : undefined);
  return {
    id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, trashed: !!f.trashed,
    ...(f.content && f.mimeType !== "application/vnd.google-apps.document" ? { size: String(f.content.length), md5Checksum: md5 } : {}),
    createdTime: "2026-01-01T00:00:00.000Z", modifiedTime: "2026-02-01T00:00:00.000Z", version: "3",
    hasThumbnail: f.mimeType.startsWith("image/"),
    ...(f.width ? { imageMediaMetadata: { width: f.width, height: f.height } } : {}),
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  G.calls.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}`);
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    const p = new URLSearchParams(String(init?.body));
    if (p.get("grant_type") === "authorization_code") {
      return json(200, { access_token: TOKEN, expires_in: 3600, refresh_token: REFRESH, scope: G.grantScope, token_type: "Bearer" });
    }
    if (G.revoked) return json(400, { error: "invalid_grant" });
    return json(200, { access_token: TOKEN, expires_in: 3600, scope: G.grantScope });
  }
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/revoke") return new Response("", { status: 200 });
  if (url.hostname !== "www.googleapis.com") return new Response("unexpected host", { status: 599 });
  const auth = new Headers(init?.headers).get("authorization");
  if (G.revoked || auth !== `Bearer ${TOKEN}`) return json(401, { error: { status: "UNAUTHENTICATED" } });
  const path = url.pathname.replace("/drive/v3", "");
  const sp = url.searchParams;
  if (path === "/about") return json(200, { user: { emailAddress: "owner@fribee.test" } });
  if (path === "/changes/startPageToken") return json(200, { startPageToken: String(G.changes.length) });
  if (path === "/changes") {
    const from = Number(sp.get("pageToken"));
    const page = G.changes.slice(from, from + G.pageSize);
    const next = from + page.length;
    const changes = page.map((c) => {
      const f = G.files.get(c.fileId);
      return c.removed || !f ? { fileId: c.fileId, removed: true } : { fileId: c.fileId, removed: false, file: fileJson(f) };
    });
    return json(200, next < G.changes.length ? { changes, nextPageToken: String(next) } : { changes, newStartPageToken: String(next) });
  }
  if (path === "/files") {
    const query = sp.get("q") ?? "";
    const byName = /^name = '(.+)' and mimeType/.exec(query);
    if (byName) return json(200, { files: [...G.files.values()].filter((f) => f.name === byName[1] && f.mimeType === FOLDER_MIME && !f.trashed).map((f) => ({ id: f.id, name: f.name, modifiedTime: "2026-02-01T00:00:00.000Z", owners: [{ displayName: "Owner" }] })) });
    const parent = /^'([A-Za-z0-9_-]+)' in parents/.exec(query)![1];
    if (G.onChildrenPage) await G.onChildrenPage();
    const all = [...G.files.values()].filter((f) => f.parents.includes(parent) && !f.trashed).sort((a, b) => a.id.localeCompare(b.id));
    const from = Number(sp.get("pageToken") ?? 0);
    const page = all.slice(from, from + G.pageSize);
    return json(200, { files: page.map(fileJson), ...(from + G.pageSize < all.length ? { nextPageToken: String(from + G.pageSize) } : {}) });
  }
  const m = /^\/files\/([A-Za-z0-9_-]+)(\/export)?$/.exec(path);
  if (m) {
    const f = G.files.get(m[1]);
    if (!f) return json(404, { error: { errors: [{ reason: "notFound" }] } });
    if (m[2]) return new Response(f.content!.toString("utf8"), { status: 200, headers: { "content-type": "text/plain" } });
    if (sp.get("alt") === "media") return new Response(new Uint8Array(f.content!), { status: 200, headers: { "content-length": String(f.content!.length) } });
    return json(200, { ...fileJson(f), thumbnailLink: `https://lh3.googleusercontent.com/fake=s220` });
  }
  return json(404, { error: { errors: [{ reason: "notFound" }] } });
}

async function scanUntilIdle(worker = "w-test", max = 40) {
  let last = null;
  for (let i = 0; i < max; i++) {
    await q(`UPDATE drive_sources SET next_scan_at = now() WHERE brand_id = $1 AND status = 'active'`, [brandId]);
    const r = await runDriveScanOnce(worker, { brandId, pages: 5 });
    if (!r) return last;
    last = r;
    if (r.status !== "partial") return r;
  }
  throw new Error("Tarama bitmedi");
}

const item = (name: string) => q1<{ id: string; path: string; state: string; image_width: number | null }>(`SELECT id, path, state, image_width FROM drive_items WHERE brand_id = $1 AND name = $2`, [brandId, name]);

let brandId: string;
let ids: Record<string, string>;
let photoFront: Buffer;

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch);
  driveRuntime.sleep = async () => {};
  driveRuntime.maxAttempts = 2;
  process.env.GOOGLE_DRIVE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = "test-client-secret-value";
  brandId = (await createBrand({ name: `Drive ${Date.now()}` })).id;

  // Orijinal ürün fotoğrafı: 2000x2500 turuncu tişört (gürültülü, gerçekçi boyut)
  photoFront = await sharp({ create: { width: 2000, height: 2500, channels: 3, background: "#f97316" } }).jpeg({ quality: 97 }).toBuffer();
  const small = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#7dd3fc" } }).jpeg().toBuffer();
  put({ id: ROOT, name: "FriBee Master Archive", mimeType: FOLDER_MIME, parents: ["myDriveRoot0000"] }, false);
  const anime = put({ id: id("fold"), name: "Anime", mimeType: FOLDER_MIME, parents: [ROOT] }, false);
  const bee = put({ id: id("fold"), name: "Save the Bee", mimeType: FOLDER_MIME, parents: [ROOT] }, false);
  const story = put({ id: id("fold"), name: "Story", mimeType: FOLDER_MIME, parents: [ROOT] }, false);
  const front = put({ id: id("file"), name: "anime-front.jpg", mimeType: "image/jpeg", parents: [anime.id], content: photoFront, width: 2000, height: 2500 }, false);
  const lowres = put({ id: id("file"), name: "bee-back-small.jpg", mimeType: "image/jpeg", parents: [bee.id], content: small, width: 600, height: 800 }, false);
  for (let i = 0; i < 4; i++) put({ id: id("file"), name: `bee-${i}.png`, mimeType: "image/png", parents: [bee.id], content: Buffer.from(`png-${i}`) }, false);
  const doc = put({ id: id("file"), name: "Characters", mimeType: "application/vnd.google-apps.document", parents: [story.id], content: Buffer.from("Bee is the hero of FriBee.\n\nBee protects the hive and loves music.") }, false);
  ids = { anime: anime.id, bee: bee.id, story: story.id, front: front.id, lowres: lowres.id, doc: doc.id };
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  G.calls = [];
  G.onChildrenPage = null;
});

describe("Google Drive arşivi", () => {
  it("OAuth: tek kullanımlık state, drive.readonly izni zorunlu, belirteçler şifreli", async () => {
    const url = new URL(await startDriveOAuth(brandId));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.readonly");
    const state = url.searchParams.get("state")!;
    expect(await consumeDriveState(state)).toBe(brandId);
    expect(await consumeDriveState(state)).toBeNull(); // ikinci kullanım reddedilir

    G.grantScope = "https://www.googleapis.com/auth/drive.metadata.readonly";
    await expect(completeDriveOAuth(brandId, "code-1")).rejects.toThrow(/drive\.readonly/);
    G.grantScope = DRIVE_SCOPES[0];
    expect(await completeDriveOAuth(brandId, "code-2")).toEqual({ email: "owner@fribee.test" });
    const raw = await q1<{ c: string }>(`SELECT row_to_json(c)::text AS c FROM connections c WHERE provider = 'google_drive' AND brand_id = $1`, [brandId]);
    expect(raw!.c).not.toContain(TOKEN);
    expect(raw!.c).not.toContain(REFRESH);
    expect((await getDriveSource(brandId))!.status).toBe("awaiting_folder");
  });

  it("klasör kullanıcı tarafından seçilir; adı eşleşmeyen klasör reddedilir", async () => {
    const c = await findArchiveFolders(brandId);
    expect(c.map((x) => x.id)).toEqual([ROOT]);
    await expect(selectArchiveFolder(brandId, ids.anime)).rejects.toThrow(/Klasör adı/);
    const s = await selectArchiveFolder(brandId, ROOT);
    expect(s).toMatchObject({ status: "active", folder_id: ROOT });
  });

  it("ilk tarama: alt klasörler ve sayfalar kaldığı yerden; yollar ve çözünürlük kaydedilir", async () => {
    const r = await scanUntilIdle();
    expect(r!.error ?? r!.status).toBe("completed");
    expect(await item("anime-front.jpg")).toMatchObject({ path: "FriBee Master Archive/Anime/anime-front.jpg", state: "indexed", image_width: 2000 });
    expect((await item("bee-3.png"))!.path).toBe("FriBee Master Archive/Save the Bee/bee-3.png");
    const n = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM drive_items WHERE brand_id = $1`, [brandId]);
    expect(n!.n).toBe(3 + 1 + 1 + 4 + 1);
    // Tarama yalnızca okuma uç noktalarını çağırır
    expect(G.calls.every((c) => c.startsWith("GET ") || c.startsWith("POST oauth2.googleapis.com/token"))).toBe(true);
  });

  it("artımlı: yeni dosya, klasör yeniden adlandırma, çöp ve klasör dışına taşıma", async () => {
    const newer = put({ id: id("file"), name: "anime-back.jpg", mimeType: "image/jpeg", parents: [ids.anime], content: Buffer.from("back"), width: 2000, height: 2500 });
    put({ ...G.files.get(ids.anime)!, name: "Anime Collection" });
    put({ ...G.files.get(ids.lowres)!, trashed: true });
    put({ ...G.files.get(newer.id)!, parents: [ids.anime] });
    const outside = G.files.get([...G.files.values()].find((f) => f.name === "bee-0.png")!.id)!;
    put({ ...outside, parents: ["elsewhere000000"] });
    const r = await scanUntilIdle();
    expect(r!.status).toBe("completed");
    expect((await item("anime-back.jpg"))!.path).toBe("FriBee Master Archive/Anime Collection/anime-back.jpg");
    expect((await item("anime-front.jpg"))!.path).toBe("FriBee Master Archive/Anime Collection/anime-front.jpg");
    expect((await item("bee-back-small.jpg"))!.state).toBe("removed");
    expect((await item("bee-0.png"))!.state).toBe("removed");
  });

  it("bağlantı kopukken silinen dosya, yeniden bağlanınca tam taramada kaldırılır", async () => {
    await disconnectDrive(brandId);
    const gone = [...G.files.values()].find((f) => f.name === "bee-1.png")!;
    G.files.delete(gone.id); // değişiklik kaydı yok: akış belirteci zaten silindi
    await completeDriveOAuth(brandId, "code-3");
    expect((await getDriveSource(brandId))!.status).toBe("active");
    const r = await scanUntilIdle();
    expect(r!.status).toBe("completed");
    expect((await item("bee-1.png"))!.state).toBe("removed");
    expect((await item("bee-2.png"))!.state).toBe("indexed");
  });

  it("yetki iptal (401): kaynak 'yeniden bağlanın' olur ve tekrar tekrar denenmez", async () => {
    G.revoked = true;
    await q(`UPDATE drive_sources SET next_scan_at = now(), changes_page_token = '0' WHERE brand_id = $1`, [brandId]);
    const conn = await getConnection("google_drive", brandId);
    expect(conn!.status).toBe("connected");
    const r = await runDriveScanOnce("w-test", { brandId });
    expect(r!.status).toBe("failed");
    expect((await getDriveSource(brandId))!.status).toBe("reauth_required");
    expect((await getConnection("google_drive", brandId))!.status).toBe("reauth_required");
    G.calls = [];
    expect(await runDriveScanOnce("w-test", { brandId })).toBeNull();
    expect(G.calls).toEqual([]);
    G.revoked = false;
    await completeDriveOAuth(brandId, "code-4");
    expect((await scanUntilIdle())!.status).toBe("completed");
  });

  it("kilit başka işleyiciye geçerse tarama hiçbir şey yazmadan durur", async () => {
    await q(`UPDATE drive_sources SET full_scan_completed_at = NULL, changes_page_token = NULL, full_scan_state = '{}'::jsonb, next_scan_at = now() WHERE brand_id = $1`, [brandId]);
    G.onChildrenPage = async () => {
      await q(`UPDATE drive_sources SET lock_owner = 'w-other' WHERE brand_id = $1`, [brandId]);
    };
    const r = await runDriveScanOnce("w-test", { brandId });
    expect(r!.status).toBe("failed");
    expect(r!.error).toMatch(/kilidi kaybedildi/);
    expect((await q1<{ lock_owner: string }>(`SELECT lock_owner FROM drive_sources WHERE brand_id = $1`, [brandId]))!.lock_owner).toBe("w-other");
    G.onChildrenPage = null;
    await q(`UPDATE drive_sources SET lock_owner = NULL, lock_expires_at = NULL WHERE brand_id = $1`, [brandId]);
    expect((await scanUntilIdle())!.status).toBe("completed");
  });

  it("inceleme: doğrulama tema, görünüm ve tasarım onayı ister; içe aktarma orijinali bayt bayt alır", async () => {
    const front = (await item("anime-front.jpg"))!;
    const { references } = await suggestReferences(brandId, [front.id]);
    const ref = references[0];
    expect(ref).toMatchObject({ status: "uncertain", suggested_theme: "anime" });
    await expect(importReferenceOriginal(brandId, ref.id)).rejects.toThrow(/doğruladığı/);
    await expect(reviewReference(brandId, ref.id, { action: "verify", theme: "anime", view: "front" })).rejects.toThrow(/Anime tasarımının/);
    await reviewReference(brandId, ref.id, { action: "verify", theme: "anime", view: "front", artworkConfirmed: true });

    const { assetId } = await importReferenceOriginal(brandId, ref.id);
    const asset = (await getMedia(brandId, assetId))!;
    expect(asset).toMatchObject({ kind: "photo", width: 2000, height: 2500, mime_type: "image/jpeg" });
    const stored = await readMediaFile(asset);
    expect(crypto.createHash("sha256").update(stored).digest("hex")).toBe(crypto.createHash("sha256").update(photoFront).digest("hex"));
    expect(await importReferenceOriginal(brandId, ref.id)).toMatchObject({ assetId, duplicate: true });

    // Ajan bağlamı: doğrulanmış referans etiket olarak, dosya medya listesinde
    let ctx = await buildBrandContext(brandId, undefined, { agent: "video" });
    expect(ctx.archive_references.map((r) => r.media_asset_id)).toContain(assetId);
    expect(ctx.media.map((m) => m.id)).toContain(assetId);
    expect(systemPrompt("video", "plan")).toMatch(/archive_references[^\n]*never treat them as product facts/);

    // Geri alınınca hiçbir ajana ve AI isteğine giremez
    await reviewReference(brandId, ref.id, { action: "reset" });
    ctx = await buildBrandContext(brandId, undefined, { agent: "video" });
    expect(ctx.archive_references).toEqual([]);
    expect(ctx.media.map((m) => m.id)).not.toContain(assetId);
    expect(await unverifiedDriveAssetIds(brandId, [assetId])).toEqual([assetId]);
  });

  it("MD5 eşleşmezse veya çözünürlük düşükse orijinal içe aktarılmaz", async () => {
    const lowName = "small-front.jpg";
    const small = await sharp({ create: { width: 700, height: 900, channels: 3, background: "#111827" } }).jpeg().toBuffer();
    const big = await sharp({ create: { width: 1600, height: 2000, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
    put({ id: id("file"), name: lowName, mimeType: "image/jpeg", parents: [ids.anime], content: small });
    put({ id: id("file"), name: "corrupt-front.jpg", mimeType: "image/jpeg", parents: [ids.anime], content: big, width: 1600, height: 2000, md5Override: "0".repeat(32) });
    await scanUntilIdle();
    for (const [name, err] of [[lowName, /Çözünürlük düşük/], ["corrupt-front.jpg", /MD5/]] as const) {
      const it = (await item(name))!;
      const { references } = await suggestReferences(brandId, [it.id]);
      await reviewReference(brandId, references[0].id, { action: "verify", theme: "music", view: "front", artworkConfirmed: true });
      await expect(importReferenceOriginal(brandId, references[0].id)).rejects.toThrow(err);
    }
  });

  it("metin belgesi Marka Hafızası'na yalnızca öneri olarak eklenir (bir kez)", async () => {
    const doc = (await item("Characters"))!;
    const r = await proposeMemoryFromDocument(brandId, doc.id, "guideline");
    expect(r).toMatchObject({ added: 1, skipped: 0 });
    const mem = (await listMemory(brandId)).filter((m) => m.source_ref === doc.id);
    expect(mem).toHaveLength(1);
    expect(mem[0]).toMatchObject({ status: "proposed", title: "Drive: Characters" });
    expect(mem[0].body).toContain("Bee is the hero of FriBee.");
    await expect(proposeMemoryFromDocument(brandId, doc.id)).rejects.toThrow(/zaten/);
    const ctx = await buildBrandContext(brandId, undefined, { agent: "marketing" });
    expect(JSON.stringify(ctx)).not.toContain("Bee is the hero");
  });

  it("uzun metin paragraf sınırlarından bölünür", () => {
    const parts = chunkText(Array.from({ length: 30 }, (_, i) => `Paragraf ${i} ${"x".repeat(300)}`).join("\n\n"), 1000);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n\n")).toContain("Paragraf 29");
  });

  it("başka markanın referansı ve öğesi bulunamaz", async () => {
    const other = (await createBrand({ name: `Drive other ${Date.now()}` })).id;
    const ref = await q1<{ id: string }>(`SELECT id FROM drive_references WHERE brand_id = $1 LIMIT 1`, [brandId]);
    await expect(importReferenceOriginal(other, ref!.id)).rejects.toThrow(/bulunamadı/);
    await expect(reviewReference(other, ref!.id, { action: "reject" })).rejects.toThrow(/bulunamadı/);
    await expect(proposeMemoryFromDocument(other, (await item("Characters"))!.id)).rejects.toThrow(/bulunamadı/);
  });

  it("tarama sonrası ürün fotoğrafları otomatik inceleme kuyruğuna girer; logo/artboard girmez ve ürün referansı olarak doğrulanamaz", async () => {
    const shoot = put({ id: id("fold"), name: "Music Shoot", mimeType: FOLDER_MIME, parents: [ROOT] });
    const real = (shade: string) => sharp({ create: { width: 1600, height: 2000, channels: 3, background: shade } }).jpeg({ quality: 92 }).toBuffer();
    put({ id: id("file"), name: "music-front.jpg", mimeType: "image/jpeg", parents: [shoot.id], content: await real("#fafafa"), width: 1600, height: 2000 });
    put({ id: id("file"), name: "music-back.jpg", mimeType: "image/jpeg", parents: [shoot.id], content: await real("#f4f4f4"), width: 1600, height: 2000 });
    put({ id: id("file"), name: "Artboard 1.png", mimeType: "image/png", parents: [shoot.id], content: await sharp({ create: { width: 2000, height: 2000, channels: 4, background: "#f97316" } }).png().toBuffer(), width: 2000, height: 2000 });
    put({ id: id("file"), name: "fribee-logo-white.png", mimeType: "image/png", parents: [ROOT], content: Buffer.from("logo"), width: 1200, height: 1200 });
    expect((await scanUntilIdle())!.status).toBe("completed");
    const refOf = (name: string) => q1<{ id: string; status: string; suggested_theme: string | null; suggested_view: string; auto: string | null }>(
      `SELECT r.id, r.status, r.suggested_theme, r.suggested_view, r.suggestion_detail->>'auto' AS auto FROM drive_references r JOIN drive_items i ON i.id = r.item_id WHERE i.brand_id = $1 AND i.name = $2`, [brandId, name]);
    const front = (await refOf("music-front.jpg"))!;
    expect(front).toMatchObject({ status: "uncertain", suggested_theme: "music", suggested_view: "front", auto: "true" });
    expect((await refOf("music-back.jpg"))!.suggested_view).toBe("back");
    expect(await refOf("Artboard 1.png")).toBeNull();
    expect(await refOf("fribee-logo-white.png")).toBeNull();
    expect(isNonProductImage("Artboard 1.png", "FriBee Master Archive/Space Alien/Artboard 1.png", "image/png")).toBe(true);
    expect(isNonProductImage("space-alien-front.jpg", "FriBee Master Archive/Logo pack/space-alien-front.jpg", "image/jpeg")).toBe(true);
    expect(isNonProductImage("space-alien-front.jpg", "FriBee Master Archive/Space Alien/space-alien-front.jpg", "image/jpeg")).toBe(false);
    // Elle kuyruğa eklenmiş logo bile ürün referansı olarak doğrulanamaz (28 Ekim: Artboard 1.png hatası)
    const art = (await suggestReferences(brandId, [(await item("Artboard 1.png"))!.id])).references[0];
    await expect(reviewReference(brandId, art.id, { action: "verify", theme: "space_alien", view: "front", artworkConfirmed: true })).rejects.toThrow(/logo\/grafik/);
    // Tekrar çalıştırmak aynı görseli ikinci kez eklemez
    expect((await autoQueueReferences(brandId)).queued).toBe(0);
  });

  it("toplu onay: tek beyanla doğrulanır, orijinaller işleyicide otomatik arşive alınır; kalıcı hata 3 denemede durur", async () => {
    const ref = async (name: string) => (await q1<{ id: string }>(`SELECT r.id FROM drive_references r JOIN drive_items i ON i.id = r.item_id WHERE i.brand_id = $1 AND i.name = $2`, [brandId, name]))!.id;
    const front = await ref("music-front.jpg"), back = await ref("music-back.jpg");
    const decisions = [{ referenceId: front, theme: "music", view: "front" }, { referenceId: back, theme: "music", view: "back" }];
    await expect(bulkReview(brandId, decisions, "verify")).rejects.toThrow(/birebir doğru/);
    const missingView = await bulkReview(brandId, [{ referenceId: front, theme: "music", view: null }], "verify", { artworkConfirmed: true });
    expect(missingView).toMatchObject({ done: 0 });
    expect(missingView.errors[0]).toMatch(/görünümü/);
    expect(await bulkReview(brandId, decisions, "verify", { artworkConfirmed: true })).toEqual({ done: 2, errors: [] });

    const results = await runReferenceImportOnce(10);
    expect(results.filter((r) => r.ok).map((r) => r.referenceId).sort()).toEqual([front, back].sort());
    const imported = await q<{ name: string; width: number; kind: string }>(
      `SELECT i.name, m.width, m.kind FROM drive_references r JOIN drive_items i ON i.id = r.item_id JOIN media_assets m ON m.id = r.media_asset_id WHERE r.id = ANY($1::uuid[]) ORDER BY i.name`, [[front, back]]);
    expect(imported).toEqual([{ name: "music-back.jpg", width: 1600, kind: "photo" }, { name: "music-front.jpg", width: 1600, kind: "photo" }]);
    expect((await runReferenceImportOnce(10)).map((r) => r.referenceId)).not.toEqual(expect.arrayContaining([front])); // içe aktarılan tekrar denenmez

    // Görsel olarak okunamayan dosya: 3 denemeden sonra durur, hata kayıtta görünür
    const broken = await ref("bee-2.png");
    await bulkReview(brandId, [{ referenceId: broken, theme: "save_the_bee", view: "front" }], "verify", { artworkConfirmed: true });
    for (let i = 0; i < 4; i++) await runReferenceImportOnce(10);
    const b = (await q1<{ media_asset_id: string | null; detail: any }>(`SELECT media_asset_id, suggestion_detail AS detail FROM drive_references WHERE id = $1`, [broken]))!;
    expect(b.media_asset_id).toBeNull();
    expect(b.detail.import_attempts).toBe(3);
    expect(b.detail.import_error).toMatch(/okunamadı|Çözünürlük/);
  });
});
