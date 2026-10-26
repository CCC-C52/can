import { looksSecret } from "@/lib/services/brand-memory";
import {
  BrandIsolationError,
  KnowledgeError,
  type ArchiveCategory,
  type Sensitivity,
} from "./types";

// FriBee Master Archive (Google Drive) dizini.
// - Yalnızca salt okunur OAuth kapsamı kabul edilir; Drive'a hiçbir yazma yapılmaz.
// - Yetki marka bazlıdır: dizin yalnızca o markaya yetkilendirilmiş kök klasörün altındaki dosyaları alır.
// - Eşitleme artımlıdır (Drive changes API sayfa belirteci); orijinal Drive kimliği, bağlantı, zaman ve revizyon geçmişi korunur.

export const DRIVE_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
] as const;

/** İstenen OAuth kapsamlarının tamamı salt okunur olmalı; aksi halde bağlantı reddedilir. */
export function assertReadOnlyScopes(scopes: string[]) {
  if (!scopes.length) throw new KnowledgeError("En az bir salt okunur Drive kapsamı gerekli.");
  const bad = scopes.filter((s) => !(DRIVE_READONLY_SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new KnowledgeError(`Yalnızca salt okunur Drive kapsamlarına izin verilir; reddedilen: ${bad.join(", ")}`);
}

/** Drive API'den gelen dosya meta verisinin ihtiyaç duyulan alt kümesi. */
export type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  /** Kök klasöre kadar üst klasör kimlikleri (yakından uzağa). */
  ancestors: string[];
  /** İnsan tarafından okunabilir klasör yolu, ör. "Collections/Space Alien/Lookbook". */
  path: string;
  modifiedTime: string;
  headRevisionId: string | null;
  md5Checksum?: string | null;
  webViewLink: string;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  trashed?: boolean;
};

export type DriveChange = { fileId: string; removed: boolean; file?: DriveFileMeta };
export type DriveChangePage = { changes: DriveChange[]; nextPageToken: string | null; newStartPageToken: string | null };

/** Drive okuma bağdaştırıcısı. Gerçek uygulama OAuth bilgisi gerektirir; testler sabit veri kaynağı kullanır. */
export interface DriveSource {
  readonly brandId: string;
  readonly rootFolderId: string;
  readonly scopes: string[];
  getStartPageToken(): Promise<string>;
  listAll(): Promise<DriveFileMeta[]>;
  listChanges(pageToken: string): Promise<DriveChangePage>;
}

export type ArchiveRevision = { revisionId: string | null; modifiedTime: string; md5: string | null; indexedAt: string };

export type ArchiveFile = {
  brandId: string;
  driveFileId: string;
  name: string;
  mimeType: string;
  path: string;
  sourceUrl: string;
  category: ArchiveCategory;
  sensitivity: Sensitivity;
  modifiedTime: string;
  revisionId: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  firstIndexedAt: string;
  lastIndexedAt: string;
  /** Eskiden yeniye revizyon geçmişi. */
  revisions: ArchiveRevision[];
  /** Kaynak Drive'da silinmiş/çöpe atılmışsa true; kayıt denetim izi için tutulur ama aramaya girmez. */
  removed: boolean;
};

const RULES: { category: ArchiveCategory; test: RegExp }[] = [
  { category: "financial_record", test: /(financ|finans|invoice|fatura|p&l|profit|budget|bütçe|bank|tax|vergi|payroll|maaş|muhasebe|accounting)/i },
  { category: "business_record", test: /(contract|sözleşme|agreement|legal|hukuk|business plan|iş planı|\bboard\b|ortaklık)/i },
  { category: "logistics", test: /(logistic|lojistik|shipping|kargo|warehouse|depo|fulfil|inventory|stok|customs|gümrük)/i },
  { category: "production_spec", test: /(\bspecs?\b|tech ?pack|production|üretim|supplier|tedarik|vendor|\bbom\b|size chart|ölçü|fabric|kumaş|factory|fabrika)/i },
  { category: "pr_coverage", test: /(press|basın|coverage|haber|article|röportaj|interview|media kit)/i },
  { category: "lookbook", test: /lookbook/i },
  // "history" içinde "story" geçtiği için koleksiyon geçmişi hikâyeden önce denetlenir.
  { category: "collection_history", test: /(collection history|koleksiyon geçmiş|archive season|season|sezon|timeline)/i },
  { category: "product_story", test: /(story|hikaye|hikâye|concept|konsept|inspiration|ilham)/i },
  { category: "product_names", test: /(product names?|ürün adları|naming|sku list|ürün listesi|catalog list)/i },
  { category: "design_source", test: /(design|tasarım|artwork|print|baskı|vector|\.ai$|\.psd$|\.svg$|source)/i },
];

/** Dosyayı klasör yolu, ad ve MIME türüne göre sınıflandırır. Belirsiz dosyalar "other" olur (inceleme kuyruğuna düşer). */
export function classifyFile(f: Pick<DriveFileMeta, "name" | "path" | "mimeType">): ArchiveCategory {
  const hay = `${f.path}/${f.name}`;
  for (const r of RULES) if (r.test.test(hay)) return r.category;
  if (f.mimeType.startsWith("video/")) return "catalog_video";
  if (f.mimeType.startsWith("image/")) return "catalog_photo";
  if (/illustrator|photoshop|postscript|svg/.test(f.mimeType)) return "design_source";
  return "other";
}

/** Kategoriden hassasiyet: finans ve iş kayıtları özel, üretim ve lojistik tedarikçi verisidir. */
export function sensitivityFor(category: ArchiveCategory): Sensitivity {
  switch (category) {
    case "financial_record": return "finance";
    case "business_record": return "private";
    case "logistics":
    case "production_spec": return "vendor";
    case "pr_coverage": return "public";
    default: return "internal";
  }
}

export type SyncReport = { added: number; updated: number; removed: number; skippedOutsideRoot: number; skippedUnchanged: number; rejectedSecretName: number };

/**
 * Bir markanın arşiv dizini. Bellek içi; kalıcı depolama için aynı arayüz bir tabloya bağlanacaktır.
 * Her işlem dizinin marka kimliğiyle sınırlıdır; başka markanın kaynağı reddedilir.
 */
export class ArchiveIndex {
  private files = new Map<string, ArchiveFile>();
  private pageToken: string | null = null;
  lastSyncedAt: string | null = null;

  constructor(readonly brandId: string, readonly rootFolderId: string, private now: () => Date = () => new Date()) {}

  get cursor() { return this.pageToken; }

  private checkSource(source: DriveSource) {
    if (source.brandId !== this.brandId) throw new BrandIsolationError("Drive kaynağı bu markaya ait değil.");
    if (source.rootFolderId !== this.rootFolderId) throw new BrandIsolationError("Drive kaynağı yetkilendirilmiş kök klasörü kullanmıyor.");
    assertReadOnlyScopes(source.scopes);
  }

  /** İlk tam tarama; ardından sayfa belirteci saklanır ve sonraki eşitlemeler artımlı yapılır. */
  async fullSync(source: DriveSource): Promise<SyncReport> {
    this.checkSource(source);
    const token = await source.getStartPageToken();
    const report = emptyReport();
    for (const f of await source.listAll()) this.upsert(f, report);
    this.pageToken = token;
    this.lastSyncedAt = this.now().toISOString();
    return report;
  }

  /** Yalnızca son belirteçten bu yana değişen dosyaları işler. */
  async incrementalSync(source: DriveSource): Promise<SyncReport> {
    this.checkSource(source);
    if (!this.pageToken) throw new KnowledgeError("Artımlı eşitlemeden önce tam tarama gerekli.");
    const report = emptyReport();
    let token: string | null = this.pageToken;
    while (token) {
      const page: DriveChangePage = await source.listChanges(token);
      for (const c of page.changes) {
        if (c.removed || !c.file || c.file.trashed) this.markRemoved(c.fileId, report);
        else this.upsert(c.file, report);
      }
      if (page.newStartPageToken) { this.pageToken = page.newStartPageToken; token = null; }
      else token = page.nextPageToken;
    }
    this.lastSyncedAt = this.now().toISOString();
    return report;
  }

  private upsert(f: DriveFileMeta, report: SyncReport) {
    if (!f.ancestors.includes(this.rootFolderId)) { report.skippedOutsideRoot++; return; }
    // Dosya adında gizli bilgi varsa (ör. "api_key=..." gibi) dizine alınmaz.
    if (looksSecret(f.name)) { report.rejectedSecretName++; return; }
    if (f.trashed) { this.markRemoved(f.id, report); return; }
    const at = this.now().toISOString();
    const prev = this.files.get(f.id);
    const rev: ArchiveRevision = { revisionId: f.headRevisionId, modifiedTime: f.modifiedTime, md5: f.md5Checksum ?? null, indexedAt: at };
    if (prev && !prev.removed && prev.revisionId === f.headRevisionId && prev.modifiedTime === f.modifiedTime) { report.skippedUnchanged++; return; }
    const category = classifyFile(f);
    this.files.set(f.id, {
      brandId: this.brandId,
      driveFileId: f.id,
      name: f.name,
      mimeType: f.mimeType,
      path: f.path,
      sourceUrl: f.webViewLink,
      category,
      sensitivity: sensitivityFor(category),
      modifiedTime: f.modifiedTime,
      revisionId: f.headRevisionId,
      size: f.size ?? null,
      width: f.width ?? null,
      height: f.height ?? null,
      firstIndexedAt: prev?.firstIndexedAt ?? at,
      lastIndexedAt: at,
      revisions: [...(prev?.revisions ?? []), rev],
      removed: false,
    });
    if (prev) report.updated++; else report.added++;
  }

  private markRemoved(fileId: string, report: SyncReport) {
    const prev = this.files.get(fileId);
    if (!prev || prev.removed) return;
    this.files.set(fileId, { ...prev, removed: true, lastIndexedAt: this.now().toISOString() });
    report.removed++;
  }

  get(brandId: string, driveFileId: string): ArchiveFile | undefined {
    if (brandId !== this.brandId) throw new BrandIsolationError("Başka markanın arşivine erişilemez.");
    return this.files.get(driveFileId);
  }

  list(brandId: string, opts: { includeRemoved?: boolean } = {}): ArchiveFile[] {
    if (brandId !== this.brandId) throw new BrandIsolationError("Başka markanın arşivine erişilemez.");
    return [...this.files.values()].filter((f) => opts.includeRemoved || !f.removed);
  }

  /** Kategori bazında sayım (Stüdyo panosu için). */
  summary(): Record<ArchiveCategory, number> {
    const out = {} as Record<ArchiveCategory, number>;
    for (const f of this.files.values()) if (!f.removed) out[f.category] = (out[f.category] ?? 0) + 1;
    return out;
  }
}

function emptyReport(): SyncReport {
  return { added: 0, updated: 0, removed: 0, skippedOutsideRoot: 0, skippedUnchanged: 0, rejectedSecretName: 0 };
}

/** Testler ve demo için sabit veri kaynağı. Ağ çağrısı yapmaz. */
export class FixtureDriveSource implements DriveSource {
  private token = 1;
  private pending: DriveChange[] = [];
  constructor(
    readonly brandId: string,
    readonly rootFolderId: string,
    private files: DriveFileMeta[],
    readonly scopes: string[] = [DRIVE_READONLY_SCOPES[0]],
  ) {}
  async getStartPageToken() { return String(this.token); }
  async listAll() { return [...this.files]; }
  /** Test yardımcısı: Drive'da bir değişiklik olmuş gibi davranır. */
  push(change: DriveChange) {
    this.pending.push(change);
    if (change.file) this.files = [...this.files.filter((f) => f.id !== change.fileId), change.file];
    else this.files = this.files.filter((f) => f.id !== change.fileId);
  }
  async listChanges(_pageToken: string): Promise<DriveChangePage> {
    const changes = this.pending;
    this.pending = [];
    this.token++;
    return { changes, nextPageToken: null, newStartPageToken: String(this.token) };
  }
}

/**
 * Gerçek Google Drive bağdaştırıcısı için yer tutucu. OAuth istemci bilgileri ve sahip onayı olmadan
 * kasıtlı olarak çalışmaz; böylece yanlışlıkla canlı Drive'a bağlanılmaz.
 */
export function googleDriveSourceNotConfigured(): never {
  throw new KnowledgeError("Google Drive bağlantısı yapılandırılmadı: salt okunur OAuth istemcisi, marka kök klasörü ve sahip onayı gerekli.");
}
