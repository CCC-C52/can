import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { loginRequired, sessionCookieName, verifySession } from "@/lib/auth";
import { requireBrand } from "@/lib/current";
import { isUuid } from "@/lib/ids";
import { listProjects, listTasks, getProject } from "@/lib/orchestrator/projects";
import { listOutputs, listVersions, listApprovals } from "@/lib/services/outputs";
import { listMedia } from "@/lib/services/media";
import { latestAnalysis, compactAnalysis } from "@/lib/media-analysis";
import { publicOutputPreview } from "@/lib/services/management-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safeHeaders = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function reply(data: unknown, status = 200) {
  return Response.json(data, { status, headers: safeHeaders });
}

/**
 * Owner session only. No bearer token, no public API key, no external fetches,
 * no writes, no media file bytes, no storage keys or signed URLs.
 * External connectors require separate authorization and security review.
 */
export async function GET(req: NextRequest) {
  if (loginRequired()) {
    const cookie = (await cookies()).get(sessionCookieName())?.value;
    if (!verifySession(cookie)) return reply({ error: "Yetkisiz erişim" }, 401);
  } else if (process.env.NODE_ENV === "production") {
    return reply({ error: "Kimlik doğrulama gerekli" }, 403);
  }
  const url = req.nextUrl;
  const section = url.searchParams.get("section") ?? "projects";
  const projectId = url.searchParams.get("projectId");
  const assetId = url.searchParams.get("assetId");
  if (projectId && !isUuid(projectId)) return reply({ error: "Geçersiz proje kimliği" }, 400);
  if (assetId && !isUuid(assetId)) return reply({ error: "Geçersiz medya kimliği" }, 400);
  const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));

  try {
    const brand = await requireBrand();
    const brandId = brand.id;
    if (projectId && !(await getProject(brandId, projectId))) return reply({ error: "Proje bulunamadı" }, 404);

    if (section === "projects") {
      const rows = await listProjects(brandId, limit);
      return reply({ section, brand: brand.name, items: rows.map(p => ({
        id: p.id, title: p.title, status: p.status, modelCalls: p.model_calls,
        createdAt: p.created_at, updatedAt: p.updated_at,
      })) });
    }
    if (section === "tasks") {
      const rows = await listTasks(brandId, projectId ? { projectId } : {});
      return reply({ section, items: rows.slice(0, limit).map(t => ({
        id: t.id, projectId: t.project_id, title: t.title, agent: t.agent, kind: t.kind,
        status: t.status, phase: t.phase, attempts: t.attempts, maxAttempts: t.max_attempts,
        failureClass: t.failure_class, hasError: !!t.error, updatedAt: t.updated_at,
      })) });
    }
    if (section === "outputs") {
      const rows = await listOutputs(brandId, { ...(projectId ? { projectId } : {}), limit });
      return reply({ section, items: await Promise.all(rows.map(async o => {
        const versions = await listVersions(brandId, o.id);
        const approvals = await listApprovals(brandId, o.id);
        const latest = versions.find(v => v.version === o.current_version);
        return {
          id: o.id, projectId: o.project_id, title: o.title, agent: o.agent, kind: o.kind,
          currentVersion: o.current_version, updatedAt: o.updated_at,
          latest: latest ? { id: latest.id, version: latest.version, preview: publicOutputPreview(o.agent, latest.content),
            qaVerdict: typeof latest.qa_report?.verdict === "string" ? latest.qa_report.verdict : null, assetIds: latest.asset_ids, isDemo: latest.is_demo } : null,
          approvals: approvals.filter(a => !a.revoked_at).map(a => ({
            versionId: a.output_version_id, decision: a.decision, scopes: a.scopes, createdAt: a.created_at,
          })),
        };
      })) });
    }
    if (section === "media") {
      const rows = await listMedia(brandId, {});
      const filtered = assetId ? rows.filter(a => a.id === assetId) : rows;
      return reply({ section, items: await Promise.all(filtered.slice(0, limit).map(async a => {
        const analysis = await latestAnalysis(brandId, a.id);
        return {
          id: a.id, productId: a.product_id, projectId: a.project_id ?? null,
          filename: a.filename, kind: a.kind, origin: a.origin, durationSeconds: a.duration_s,
          width: a.width, height: a.height, rightsStatus: a.rights_status,
          analysis: analysis ? { status: analysis.status, level: analysis.level,
            summary: compactAnalysis(analysis), hasError: !!analysis.error } : null,
        };
      })) });
    }
    return reply({ error: "Geçersiz bölüm. projects, tasks, outputs veya media kullanın." }, 400);
  } catch {
    return reply({ error: "Kayıtlar okunamadı" }, 500);
  }
}
