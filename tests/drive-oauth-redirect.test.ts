import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeDriveState: vi.fn(),
  completeDriveOAuth: vi.fn(),
  upsertConnection: vi.fn(),
}));

vi.mock("@/lib/drive/source", () => ({
  ...mocks,
  safeError: (err: Error) => err.message,
}));
vi.mock("@/lib/services/connections", () => ({ upsertConnection: mocks.upsertConnection }));

import { GET } from "@/app/api/integrations/google-drive/callback/route";

const PUBLIC_ORIGIN = "https://aiops-web.onrender.com";
const INTERNAL_ORIGIN = "http://0.0.0.0:10000";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PUBLIC_BASE_URL", PUBLIC_ORIGIN);
  mocks.consumeDriveState.mockResolvedValue("test-brand");
  mocks.completeDriveOAuth.mockResolvedValue({ email: "owner@fribee.test" });
  mocks.upsertConnection.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

function request(query: string) {
  return new Request(`${INTERNAL_ORIGIN}/api/integrations/google-drive/callback?${query}`, {
    headers: { host: "untrusted.example", "x-forwarded-host": "untrusted.example" },
  });
}

function destination(response: Response) {
  expect(response.status).toBe(307);
  const target = new URL(response.headers.get("location")!);
  expect(target.origin).toBe(PUBLIC_ORIGIN);
  expect(target.pathname).toBe("/drive-arsivi");
  expect(target.searchParams.has("state")).toBe(false);
  expect(target.searchParams.has("code")).toBe(false);
  return target;
}

describe("Drive OAuth public return address", () => {
  it("returns success to the public origin instead of the container address or forwarded host", async () => {
    const target = destination(await GET(request("state=state-fixture&code=code-fixture")));
    expect(target.searchParams.get("ok")).toContain("Google Drive bağlandı");
    expect(mocks.completeDriveOAuth).toHaveBeenCalledWith("test-brand", "code-fixture");
  });

  it("uses Render's public origin when PUBLIC_BASE_URL is unset", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "");
    vi.stubEnv("RENDER_EXTERNAL_URL", PUBLIC_ORIGIN);
    destination(await GET(request("state=state-fixture&code=code-fixture")));
  });

  it("returns invalid state errors to the public origin without exchanging a code", async () => {
    mocks.consumeDriveState.mockResolvedValue(null);
    const target = destination(await GET(request("state=expired&code=code-fixture")));
    expect(target.searchParams.get("err")).toContain("Geçersiz veya süresi dolmuş");
    expect(mocks.completeDriveOAuth).not.toHaveBeenCalled();
  });

  it("returns denied consent to the public origin without exchanging a code", async () => {
    const target = destination(await GET(request("state=state-fixture&error=access_denied")));
    expect(target.searchParams.get("err")).toContain("access_denied");
    expect(mocks.completeDriveOAuth).not.toHaveBeenCalled();
  });

  it("returns missing-code errors to the public origin", async () => {
    const target = destination(await GET(request("state=state-fixture")));
    expect(target.searchParams.get("err")).toBe("Yetkilendirme kodu yok.");
    expect(mocks.completeDriveOAuth).not.toHaveBeenCalled();
  });

  it("returns exchange failures to the public origin and keeps the connection error", async () => {
    mocks.completeDriveOAuth.mockRejectedValue(new Error("invalid_client"));
    const target = destination(await GET(request("state=state-fixture&code=code-fixture")));
    expect(target.searchParams.get("err")).toContain("invalid_client");
    expect(mocks.upsertConnection).toHaveBeenCalledWith("google_drive", "test-brand", {
      status: "error", lastError: "invalid_client",
    });
  });
});
