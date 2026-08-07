import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startInfisicalAuth } from "./infisical-auth";

const { currentUser } = vi.hoisted(() => ({
  currentUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ currentUser }));
vi.mock("@opencompany/db/client", () => ({ getDb: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("opencompany Infisical auth actions", () => {
  beforeEach(() => {
    currentUser.mockResolvedValue({
      role: "admin",
      user: { workosUserId: "user_1" },
      workspace: { id: "workspace_1" },
    });
    vi.stubEnv("RUNNER_PUBLIC_URL", "https://runner.example.com");
    vi.stubEnv("RUNNER_INTERNAL_TOKEN", "runner-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("accepts a runner login link for the selected EU region", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      flowResponse("https://eu.infisical.com"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(startInfisicalAuth({ host: "https://eu.infisical.com" })).resolves.toMatchObject({
      ok: true,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      host: "https://eu.infisical.com",
    });
  });

  it("does not present a mismatched login link during a rolling runner deploy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => flowResponse("https://app.infisical.com")),
    );

    await expect(startInfisicalAuth({ host: "https://eu.infisical.com" })).resolves.toEqual({
      ok: false,
      error: "The selected Infisical region is still updating. Please try again in a minute.",
    });
  });
});

function flowResponse(host: "https://app.infisical.com" | "https://eu.infisical.com") {
  return new Response(
    JSON.stringify({
      ok: true,
      flow: {
        id: "ginff_123",
        status: "link_ready",
        loginUrl: `${host}/login?callback_port=12345`,
        statusReason: null,
        expiresAt: "2026-08-07T09:00:00.000Z",
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
