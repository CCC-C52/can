// Üretim imajı içinde medya duman testi (CI Docker işi): imajdaki ffmpeg sürümüyle gerçek MP4 kurgusu.
//   docker run --rm <imaj> npx tsx --tsconfig tsconfig.json scripts/release/smoke-media.ts
// Sentetik kaynak (renk geçişli test deseni + ses) → aynı kaynaktan 3 bölüm, ekran metni → H.264 1080x1920 MP4 →
// ffprobe ile codec/boyut/süre ve baştan sona hatasız çözme doğrulaması. Veritabanı veya ağ gerekmez.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderEdit } from "@/lib/adapters/video-edit";
import { verifyVideoFile } from "@/lib/video/verify";
import JSZip from "jszip";
import { parseDocx, parsePdf } from "@/lib/brain/parsers";

/** Brand Brain ayrıştırıcıları üretim imajında: poppler pdftotext ve OOXML (AI değil). */
async function brainParsers() {
  const stream = "BT /F1 12 Tf 72 720 Td (FriBee Space Alien story) Tj ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n";
  const off: number[] = [];
  objs.forEach((o, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  const p = await parsePdf(Buffer.from(pdf, "latin1"));
  if (!p.ok || !p.sections[0].text.includes("FriBee Space Alien story")) throw new Error(`PDF ayrıştırılamadı: ${JSON.stringify(p)}`);
  const z = new JSZip();
  z.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Music collection</w:t></w:r></w:p></w:body></w:document>`);
  const d = await parseDocx(await z.generateAsync({ type: "nodebuffer" }));
  if (!d.ok || !d.sections[0].text.includes("Music collection")) throw new Error("DOCX ayrıştırılamadı");
  return { pdf: "ok", docx: "ok", pdftotext: execFileSync("pdftotext", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0] || "ok" };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  try {
    const src = path.join(dir, "source.mp4");
    // 3 renkli bölüm (kırmızı/sarı/mavi, her biri 4 sn) + 440 Hz ses; dikey 1080x1920
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=1080x1920:r=30:d=4",
      "-f", "lavfi", "-i", "color=c=yellow:s=1080x1920:r=30:d=4",
      "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=30:d=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
    ]);
    const ffmpegVersion = execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0];
    const r = await renderEdit({
      clips: [
        { file: src, start: 0.5, duration: 2.5, sourceDuration: 12, text: "Real footage" },
        { file: src, start: 4.5, duration: 2.5, sourceDuration: 12, text: "Same source, new scene" },
        { file: src, start: 8.5, duration: 2.5, sourceDuration: 12 },
      ],
      format: "9:16",
      transition: "cut",
      timeoutMs: 600_000,
    });
    const out = path.join(dir, "out.mp4");
    fs.writeFileSync(out, r.video);
    const ev = await verifyVideoFile(out, { width: 1080, height: 1920, duration: r.expectedDuration, audio: "aac" });
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,pix_fmt:format=duration", "-of", "json", out], { encoding: "utf8" }));
    const s = probe.streams[0];
    if (s.codec_name !== "h264" || s.width !== 1080 || s.height !== 1920) throw new Error(`Beklenmeyen çıktı: ${JSON.stringify(s)}`);
    const dur = Number(probe.format.duration);
    if (Math.abs(dur - r.expectedDuration) > 0.5) throw new Error(`Süre ${dur} sn, beklenen ${r.expectedDuration} sn`);
    const brain = await brainParsers();
    console.log(JSON.stringify({ ok: true, brain, ffmpeg: ffmpegVersion, codec: s.codec_name, width: s.width, height: s.height, pixFmt: s.pix_fmt, audio: ev.audio_codec, decoded: ev.decoded, durationS: dur, expectedS: r.expectedDuration, bytes: r.video.length, overlays: r.overlays.length }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`MEDYA DUMAN TESTİ BAŞARISIZ: ${(err as Error).message}`);
  process.exit(1);
});
