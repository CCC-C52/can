import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  authenticated: true,
  brandId: "11111111-1111-4111-8111-111111111111",
  getProject: vi.fn(),
  listProjects: vi.fn(),
  listTasks: vi.fn(),
  listOutputs: vi.fn(),
  listVersions: vi.fn(),
  listApprovals: vi.fn(),
  listMedia: vi.fn(),
  latestAnalysis: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "session" }) }) }));
vi.mock("@/lib/auth", () => ({
  loginRequired: () => true,
  sessionCookieName: () => "aiops_session",
  verifySession: () => m.authenticated,
}));
vi.mock("@/lib/current", () => ({
  requireBrand: async () => ({ id: m.brandId, name: "FriBee" }),
}));
vi.mock("@/lib/orchestrator/projects", () => ({
  getProject: m.getProject,
  listProjects: m.listProjects,
  listTasks: m.listTasks,
}));
vi.mock("@/lib/services/outputs", () => ({
  listOutputs: m.listOutputs,
  listVersions: m.listVersions,
  listApprovals: m.listApprovals,
}));
vi.mock("@/lib/services/media", () => ({ listMedia: m.listMedia }));
vi.mock("@/lib/media-analysis", () => ({
  latestAnalysis: m.latestAnalysis,
  compactAnalysis: (a: { result?: unknown }) => a.result ?? null,
}));

import { GET } from "@/app/api/management/route";

const A = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const req = (qs: string) => new NextRequest(`http://localhost:3000/api/management?${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  m.authenticated = true;
  m.brandId = A;
  m.getProject.mockResolvedValue(null);
  m.listProjects.mockResolvedValue([]);
  m.listTasks.mockResolvedValue([]);
  m.listOutputs.mockResolvedValue([]);
  m.listVersions.mockResolvedValue([]);
  m.listApprovals.mockResolvedValue([]);
  m.listMedia.mockResolvedValue([]);
  m.latestAnalysis.mockResolvedValue(null);
});

describe("FriBee management API authorization and brand isolation", () => {
  it("rejects missing or invalid owner session before any data query", async () => {
    m.authenticated = false;
    const response = await GET(req("section=projects"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(m.listProjects).not.toHaveBeenCalled();
    expect(m.listMedia).not.toHaveBeenCalled();
  });

  it("scopes project listing to the session brand and caps page size", async () => {
    const response = await GET(req("section=projects&limit=999"));
    expect(response.status).toBe(200);
    expect(m.listProjects).toHaveBeenCalledWith(A, 50);
  });

  it("does not permit cross-brand project lookups for tasks or outputs", async () => {
    for (const section of ["tasks", "outputs"]) {
      const response = await GET(req(`section=${section}&projectId=${OTHER_PROJECT}`));
      expect(response.status).toBe(404);
    }
    expect(m.getProject).toHaveBeenCalledWith(A, OTHER_PROJECT);
    expect(m.listTasks).not.toHaveBeenCalled();
    expect(m.listOutputs).not.toHaveBeenCalled();
  });

  it("scopes media listing and analysis to session brand; excludes storage credentials", async () => {
    m.listMedia.mockResolvedValue([{
      id: "33333333-3333-4333-8333-333333333333", filename: "space-alien.mp4",
      product_id: null, project_id: null, kind: "video", origin: "real_video",
      duration_s: 15, width: 1080, height: 1920, rights_status: "owned",
      storage_key: "secret-bucket-path", sha256: "secret-sha",
    }]);
    const response = await GET(req("section=media"));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(m.listMedia).toHaveBeenCalledWith(A, {});
    expect(m.latestAnalysis).toHaveBeenCalledWith(A, "33333333-3333-4333-8333-333333333333");
    expect(JSON.stringify(data)).not.toContain("secret-bucket-path");
    expect(JSON.stringify(data)).not.toContain("secret-sha");
  });

  it("rejects invalid identifiers and unsupported sections", async () => {
    expect((await GET(req("section=tasks&projectId=not-a-uuid"))).status).toBe(400);
    expect((await GET(req("section=invalid"))).status).toBe(400);
  });

  it("redacts internal exceptions from client errors", async () => {
    m.listProjects.mockRejectedValue(new Error("DATABASE_URL=private-secret"));
    const response = await GET(req("section=projects"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-secret");
  });
});
