import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { PermanentError } from "@/lib/models/types";

// Brand Brain belge ayrıştırıcıları. Tamamen deterministik ve yereldir: AI veya ücretli servis kullanılmaz.
//  - PDF: poppler `pdftotext` (ayrı süreç; bellek işleyiciden bağımsız, süre sınırlı). Sayfa sınırı \f ile korunur.
//  - DOCX / XLSX / PPTX: OOXML (zip + XML) doğrudan okunur; makro, gömülü nesne veya dış bağlantı çalıştırılmaz.
//  - TXT / Markdown / CSV / Google Dokümanı (düz metin dışa aktarımı).
// Okunamayan içerik UYDURULMAZ: sonuç "unsupported" veya "metadata_only" sınırlamasıyla döner.

export const PARSER_VERSION = 1;

export type Section = { label: string; text: string };
export type ParseResult =
  | { ok: true; parser: string; sections: Section[]; pages?: number; meta?: Record<string, unknown> }
  | { ok: false; parser: string; status: "unsupported" | "metadata_only"; limitation: string };

export const MIME = {
  gdoc: "application/vnd.google-apps.document",
  gsheet: "application/vnd.google-apps.spreadsheet",
  gslides: "application/vnd.google-apps.presentation",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

/** Bir Drive dosyasının nasıl okunacağı: içerik ayrıştırma, Google dışa aktarımı veya yalnızca üst veri. */
export type ReadPlan =
  | { kind: "content"; parser: "text" | "markdown" | "csv" | "pdf" | "docx" | "xlsx" | "pptx"; exportMime?: string }
  | { kind: "metadata"; media: "image" | "video" | "audio" | "other"; limitation: string };

export function readPlanFor(mime: string, name: string): ReadPlan {
  const lower = name.toLowerCase();
  if (mime === MIME.gdoc) return { kind: "content", parser: "text", exportMime: "text/plain" };
  if (mime === MIME.gslides) return { kind: "content", parser: "text", exportMime: "text/plain" };
  if (mime === MIME.gsheet) return { kind: "content", parser: "xlsx", exportMime: MIME.xlsx };
  if (mime === MIME.pdf || lower.endsWith(".pdf")) return { kind: "content", parser: "pdf" };
  if (mime === MIME.docx || lower.endsWith(".docx")) return { kind: "content", parser: "docx" };
  if (mime === MIME.xlsx || lower.endsWith(".xlsx")) return { kind: "content", parser: "xlsx" };
  if (mime === MIME.pptx || lower.endsWith(".pptx")) return { kind: "content", parser: "pptx" };
  if (mime === "text/csv" || lower.endsWith(".csv")) return { kind: "content", parser: "csv" };
  if (mime === "text/markdown" || lower.endsWith(".md") || lower.endsWith(".markdown")) return { kind: "content", parser: "markdown" };
  if (mime === "text/plain" || lower.endsWith(".txt")) return { kind: "content", parser: "text" };
  if (/(illustrator|photoshop|postscript|\.ai$|\.psd$)/i.test(`${mime} ${lower}`)) return { kind: "metadata", media: "other", limitation: "Tasarım kaynak dosyası (AI/PSD): yalnızca üst veri; içerik ayrıştırılmaz." };
  if (mime.startsWith("image/")) return { kind: "metadata", media: "image", limitation: "Görsel: yalnızca üst veri dizinlenir (piksel içeriği okunmaz; ürün kimliği sahip doğrulamasıyla belirlenir)." };
  if (mime.startsWith("video/")) return { kind: "metadata", media: "video", limitation: "Video: yalnızca üst veri ve (varsa) medya arşivindeki sahne analizi dizinlenir; video baytları kopyalanmaz." };
  if (mime.startsWith("audio/")) return { kind: "metadata", media: "audio", limitation: "Ses: yalnızca üst veri dizinlenir; transkripsiyon kapalı (ücretli, sahip onayı ve sağlayıcı gerekir)." };
  if (mime === "application/msword" || lower.endsWith(".doc")) return { kind: "metadata", media: "other", limitation: "Eski Word (.doc) biçimi desteklenmiyor; DOCX veya Google Dokümanı olarak kaydedilirse okunur." };
  if (/(illustrator|photoshop|postscript|\.ai$|\.psd$)/i.test(`${mime} ${lower}`)) return { kind: "metadata", media: "other", limitation: "Tasarım kaynak dosyası (AI/PSD): yalnızca üst veri; içerik ayrıştırılmaz." };
  return { kind: "metadata", media: "other", limitation: `Desteklenmeyen biçim (${mime}): yalnızca üst veri dizinlenir.` };
}

/** Kontrol karakterlerini atar, satır sonlarını ve boşlukları sadeleştirir. */
export function cleanText(s: string) {
  return s.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, "").replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => safeChar(Number(d))).replace(/&amp;/g, "&");
function safeChar(cp: number) {
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
}

const MAX_ZIP_ENTRY = 40 * 1024 * 1024;
async function zipText(zip: JSZip, name: string): Promise<string | null> {
  const f = zip.file(name);
  if (!f) return null;
  // Zip bombası koruması: açılmış boyut sınırı (JSZip sıkıştırılmamış boyutu bildirir)
  const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof size === "number" && size > MAX_ZIP_ENTRY) throw new PermanentError(`${name} çok büyük (${(size / 1e6).toFixed(0)} MB açılmış).`);
  return f.async("string");
}
async function openZip(buf: Buffer, kind: string) {
  try {
    return await JSZip.loadAsync(buf);
  } catch {
    throw new PermanentError(`${kind} dosyası açılamadı (bozuk veya parolalı olabilir).`);
  }
}
const numericOrder = (a: string, b: string) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);

// ---------------------------------------------------------------- DOCX

export async function parseDocx(buf: Buffer): Promise<ParseResult> {
  const zip = await openZip(buf, "DOCX");
  const xml = await zipText(zip, "word/document.xml");
  if (xml === null) return { ok: false, parser: "docx", status: "unsupported", limitation: "DOCX içinde word/document.xml yok." };
  const sections: Section[] = [];
  let label = "Belge";
  let cur: string[] = [];
  const flush = () => {
    const text = cleanText(cur.join("\n"));
    if (text) sections.push({ label, text });
    cur = [];
  };
  for (const p of xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
    const text = decodeXml((p.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")).trim();
    if (!text) continue;
    if (/^(Heading|Title|Başlık)/i.test(style)) {
      flush();
      label = text.slice(0, 120);
      cur.push(text);
    } else cur.push(text);
  }
  flush();
  return sections.length ? { ok: true, parser: "docx", sections } : { ok: false, parser: "docx", status: "metadata_only", limitation: "DOCX'te okunabilir metin yok." };
}

// ---------------------------------------------------------------- XLSX (ve Google E-Tablo dışa aktarımı)

const MAX_ROWS_PER_SHEET = 2000;
function colIndex(ref: string) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function parseXlsx(buf: Buffer): Promise<ParseResult> {
  const zip = await openZip(buf, "XLSX");
  const wb = await zipText(zip, "xl/workbook.xml");
  if (wb === null) return { ok: false, parser: "xlsx", status: "unsupported", limitation: "XLSX içinde xl/workbook.xml yok." };
  const shared = ((await zipText(zip, "xl/sharedStrings.xml")) ?? "").match(/<si>[\s\S]*?<\/si>/g)?.map((si) => decodeXml((si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join(""))) ?? [];
  const rels = (await zipText(zip, "xl/_rels/workbook.xml.rels")) ?? "";
  const target = new Map([...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2].replace(/^\/?xl\//, "")]));
  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: decodeXml(m[1]), file: `xl/${target.get(m[2]) ?? ""}` }));
  const sections: Section[] = [];
  let truncated = false;
  for (const s of sheets) {
    const xml = await zipText(zip, s.file);
    if (!xml) continue;
    const lines: string[] = [];
    for (const row of xml.match(/<row[\s>][\s\S]*?<\/row>/g) ?? []) {
      if (lines.length >= MAX_ROWS_PER_SHEET) { truncated = true; break; }
      const cells: string[] = [];
      for (const c of row.match(/<c[\s>][\s\S]*?<\/c>|<c[^>]*\/>/g) ?? []) {
        const ref = /r="([A-Z]+\d+)"/.exec(c)?.[1];
        const t = /t="([^"]+)"/.exec(c)?.[1];
        let v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1] ?? "";
        if (t === "s") v = shared[Number(v)] ?? "";
        else if (t === "inlineStr") v = (c.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "")).join("");
        v = decodeXml(v).trim();
        if (!v) continue;
        const i = ref ? colIndex(ref) : cells.length;
        cells[i] = v;
      }
      const line = cells.map((x) => x ?? "").join(" | ").replace(/( \| )+$/, "").trim();
      if (line.replace(/[| ]/g, "")) lines.push(line);
    }
    if (lines.length) sections.push({ label: `Sayfa: ${s.name}`, text: lines.join("\n") });
  }
  if (!sections.length) return { ok: false, parser: "xlsx", status: "metadata_only", limitation: "Tabloda okunabilir hücre yok." };
  return { ok: true, parser: "xlsx", sections, meta: { sheets: sheets.length, truncated } };
}

// ---------------------------------------------------------------- PPTX

export async function parsePptx(buf: Buffer): Promise<ParseResult> {
  const zip = await openZip(buf, "PPTX");
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(numericOrder);
  if (!slides.length) return { ok: false, parser: "pptx", status: "unsupported", limitation: "PPTX içinde slayt yok." };
  const sections: Section[] = [];
  for (const [i, s] of slides.entries()) {
    const xml = (await zipText(zip, s)) ?? "";
    const paras = (xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) ?? []).map((p) => decodeXml((p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")).trim()).filter(Boolean);
    const notesXml = await zipText(zip, s.replace("slides/slide", "notesSlides/notesSlide"));
    const notes = notesXml ? (notesXml.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => decodeXml(t.replace(/<[^>]+>/g, ""))).join(" ").trim() : "";
    const text = cleanText([...paras, ...(notes ? [`Notlar: ${notes}`] : [])].join("\n"));
    if (text) sections.push({ label: `Slayt ${i + 1}`, text });
  }
  return sections.length ? { ok: true, parser: "pptx", sections, pages: slides.length } : { ok: false, parser: "pptx", status: "metadata_only", limitation: "Slaytlarda okunabilir metin yok (yalnızca görsel olabilir; OCR kapalı)." };
}

// ---------------------------------------------------------------- PDF (poppler pdftotext)

export const PDF_TIMEOUT_MS = 60_000;

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function parsePdf(buf: Buffer): Promise<ParseResult> {
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, parser: "pdf", status: "unsupported", limitation: "Dosya PDF değil (imza yok)." };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-pdf-"));
  try {
    const file = path.join(dir, "in.pdf");
    await fs.writeFile(file, buf);
    let out: string;
    try {
      out = (await run(process.env.PDFTOTEXT_PATH || "pdftotext", ["-enc", "UTF-8", "-q", file, "-"], PDF_TIMEOUT_MS)).stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
      if (e.code === "ENOENT") throw new PermanentError("pdftotext bulunamadı (poppler-utils kurulu değil).");
      if (e.killed) throw new PermanentError(`PDF ${PDF_TIMEOUT_MS / 1000} sn içinde okunamadı.`);
      const msg = String(e.stderr ?? "").slice(0, 200);
      if (/password|encrypt/i.test(msg)) return { ok: false, parser: "pdf", status: "unsupported", limitation: "Parolalı/şifreli PDF: içerik okunamaz (parola istenmez, uydurulmaz)." };
      return { ok: false, parser: "pdf", status: "unsupported", limitation: `PDF okunamadı (bozuk olabilir): ${msg || "pdftotext hata verdi"}` };
    }
    const pages = out.split("\f");
    if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
    const sections = pages.map((p, i) => ({ label: `Sayfa ${i + 1}`, text: cleanText(p) })).filter((s) => s.text);
    if (!sections.length) return { ok: false, parser: "pdf", status: "metadata_only", limitation: "PDF'te metin katmanı yok (taranmış görsel olabilir); OCR kapalı olduğu için içerik okunmadı." };
    return { ok: true, parser: "pdf", sections, pages: pages.length };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Metin, Markdown, CSV

export function parseText(buf: Buffer, kind: "text" | "markdown" | "csv"): ParseResult {
  if (buf.includes(0)) return { ok: false, parser: kind, status: "unsupported", limitation: "Metin dosyası ikili veri içeriyor." };
  const text = cleanText(buf.toString("utf8"));
  if (!text) return { ok: false, parser: kind, status: "metadata_only", limitation: "Dosya boş." };
  if (kind === "markdown") {
    const sections: Section[] = [];
    let label = "Belge";
    let cur: string[] = [];
    for (const line of text.split("\n")) {
      const h = /^(#{1,3})\s+(.+)$/.exec(line);
      if (h) {
        if (cur.join("").trim()) sections.push({ label, text: cur.join("\n").trim() });
        label = h[2].trim().slice(0, 120);
        cur = [line];
      } else cur.push(line);
    }
    if (cur.join("").trim()) sections.push({ label, text: cur.join("\n").trim() });
    return { ok: true, parser: "markdown", sections };
  }
  if (kind === "csv") {
    const lines = text.split("\n").slice(0, MAX_ROWS_PER_SHEET);
    return { ok: true, parser: "csv", sections: [{ label: "Tablo", text: lines.join("\n") }], meta: { truncated: text.split("\n").length > MAX_ROWS_PER_SHEET } };
  }
  return { ok: true, parser: "text", sections: [{ label: "Belge", text }] };
}

/** İçerik planına göre ayrıştırır. */
export async function parseContent(plan: Extract<ReadPlan, { kind: "content" }>, buf: Buffer): Promise<ParseResult> {
  switch (plan.parser) {
    case "pdf": return parsePdf(buf);
    case "docx": return parseDocx(buf);
    case "xlsx": return parseXlsx(buf);
    case "pptx": return parsePptx(buf);
    default: return parseText(buf, plan.parser);
  }
}

// ---------------------------------------------------------------- Parçalama

export const CHUNK_CHARS = 1400;
const CHUNK_OVERLAP = 150;

/** Bölümleri yaklaşık 1.400 karakterlik, paragraf sınırına saygılı parçalara böler (bölüm etiketi korunur). */
export function chunkSections(sections: Section[], size = CHUNK_CHARS): { section: string; text: string }[] {
  const out: { section: string; text: string }[] = [];
  for (const s of sections) {
    let cur = "";
    const push = () => { if (cur.trim()) out.push({ section: s.label, text: cur.trim() }); };
    for (const para of s.text.split(/\n{2,}|\n(?=[-*•]\s)/)) {
      const p = para.trim();
      if (!p) continue;
      if (cur && cur.length + p.length + 2 > size) {
        push();
        cur = cur.slice(-CHUNK_OVERLAP).replace(/^\S*\s/, "");
      }
      if (p.length > size) {
        for (let i = 0; i < p.length; i += size - CHUNK_OVERLAP) {
          cur = p.slice(i, i + size);
          push();
        }
        cur = "";
        continue;
      }
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    push();
  }
  return out;
}
