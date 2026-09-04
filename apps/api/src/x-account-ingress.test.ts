import { createHash } from "node:crypto";
import { captureIntegrationAddedAnalytics } from "@opencompany/agent/integrations/analytics";
import { createXAccountIntegrationState } from "@opencompany/agent/integrations/x-account";
import { connectXAccountIntegration } from "@opencompany/db/integrations";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createXAccountIngress } from "./x-account-ingress";

vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connectXAccountIntegration: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/analytics", () => ({
  captureIntegrationAddedAnalytics: vi.fn(),
}));

const sentinelDb = { sentinel: "db" };
const PKCE_COOKIE = "goat_x_pkce_verifier";

function ingress(
  overrides: {
    authError?: ApiError;
    refresh?: (input: { userWorkosId: string; workspaceIds: string[] }) => Promise<void>;
  } = {},
) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue([
    { workspace: { id: "workspace_1", workosOrganizationId: null }, role: "admin" },
  ] as never);
  return createXAccountIngress({
    db: sentinelDb,
    identify: async () => {
      if (overrides.authError) throw overrides.authError;
      return {
        userId: "user_1",
        organizationId: null,
        method: "session",
        credentialKind: "browser_cookie",
        activeWorkspaceId: null,
        activeBrainId: null,
      };
    },
    ...(overrides.refresh ? { refreshPluginRegistrations: overrides.refresh } : {}),
  });
}

function callbackRequest(input: { state: string; code?: string; verifier?: string }) {
  const url = new URL("https://api.example.com/integrations/x-account/callback");
  url.searchParams.set("state", input.state);
  if (input.code) url.searchParams.set("code", input.code);
  return new Request(url, {
    headers: input.verifier ? { cookie: `${PKCE_COOKIE}=${input.verifier}` } : {},
  });
}

function stubXFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.x.com/2/oauth2/token")) {
      return Response.json({
        access_token: "x-access-token",
        refresh_token: "x-refresh-token",
        scope: "tweet.read tweet.write users.read offline.access",
        expires_in: 7200,
      });
    }
    if (url.startsWith("https://api.x.com/2/users/me")) {
      return Response.json({
        data: { id: "x_user_1", username: "goat_dev", name: "opencompany Dev" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("X account ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("OPENCOMPANY_X_CLIENT_ID", "x-client");
    vi.stubEnv("OPENCOMPANY_X_CLIENT_SECRET", "x-client-secret");
    vi.stubEnv("OPENCOMPANY_X_STATE_SECRET", "x-state-secret-x-state-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redirects to X authorization with an S256 challenge and sets the PKCE cookie", async () => {
    const response = await ingress().start(
      new Request("https://api.example.com/integrations/x-account/start?returnTo=/settings"),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://x.com");
    expect(location.pathname).toBe("/i/oauth2/authorize");
    expect(location.searchParams.get("client_id")).toBe("x-client");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    // Attribute parity with the retired next/headers cookie (Secure appears
    // only under NODE_ENV=production, which vitest does not run in).
    const setCookie = response.headers.get("set-cookie") ?? "";
    const match = setCookie.match(
      /^goat_x_pkce_verifier=([A-Za-z0-9_-]+); Path=\/; Max-Age=600; HttpOnly; SameSite=Lax$/,
    );
    expect(match, setCookie).not.toBeNull();

    // The challenge must be the S256 hash of the verifier the cookie carries.
    const verifier = match?.[1] ?? "";
    expect(location.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });

  it("exchanges the code with the cookie verifier, connects through the injected db, and deletes the cookie", async () => {
    const fetchMock = stubXFetch();
    const refresh = vi.fn(async () => undefined);
    vi.mocked(connectXAccountIntegration).mockResolvedValue({
      integrationId: "gint_x_1",
    } as never);
    const state = createXAccountIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings",
    });

    const response = await ingress({ refresh }).callback(
      callbackRequest({ state, code: "auth-code", verifier: "verifier123" }),
    );

    expect(response.headers.get("location")).toBe(
      "https://opencompany.example.com/settings?integration=x_account&setup=connected",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "goat_x_pkce_verifier=; Path=/; Max-Age=0",
    );

    const tokenRequest = fetchMock.mock.calls[0]?.[1];
    const tokenBody = new URLSearchParams(String(tokenRequest?.body));
    expect(tokenBody.get("code")).toBe("auth-code");
    expect(tokenBody.get("code_verifier")).toBe("verifier123");

    expect(connectXAccountIntegration).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      xUserId: "x_user_1",
      username: "goat_dev",
      name: "opencompany Dev",
      accessToken: "x-access-token",
      refreshToken: "x-refresh-token",
      expiresAt: expect.any(Date),
      scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
      db: sentinelDb,
    });
    expect(captureIntegrationAddedAnalytics).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      provider: "x_account",
    });
    expect(refresh).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      workspaceIds: ["workspace_1"],
    });
  });

  it("maps a missing PKCE cookie to missing_code", async () => {
    const state = createXAccountIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings",
    });
    const response = await ingress().callback(callbackRequest({ state, code: "auth-code" }));
    expect(response.headers.get("location")).toBe(
      "https://opencompany.example.com/settings?integration=x_account&setup=error&reason=missing_code",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(connectXAccountIntegration).not.toHaveBeenCalled();
  });

  it("rejects a tampered state with invalid_state and still deletes the cookie", async () => {
    const response = await ingress().callback(
      callbackRequest({ state: "garbage", code: "auth-code", verifier: "verifier123" }),
    );
    expect(response.headers.get("location")).toBe(
      "https://opencompany.example.com/settings?integration=x_account&setup=error&reason=invalid_state",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "goat_x_pkce_verifier=; Path=/; Max-Age=0",
    );
  });
});
