import { createHmac } from "node:crypto";
import {
  completeLatitudeMcpOAuth,
  startLatitudeMcpOAuth,
} from "@opencompany/agent/integrations/latitude-mcp";
import {
  completeLinearMcpOAuth,
  startLinearMcpOAuth,
} from "@opencompany/agent/integrations/linear-mcp";
import { completeNeonMcpOAuth, startNeonMcpOAuth } from "@opencompany/agent/integrations/neon-mcp";
import {
  completePostHogMcpOAuth,
  startPostHogMcpOAuth,
} from "@opencompany/agent/integrations/posthog-mcp";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createMcpOAuthIngress, type McpOAuthProvider } from "./mcp-oauth-ingress";

vi.mock("@opencompany/db/workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspacesForUser: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/linear-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startLinearMcpOAuth: vi.fn(),
  completeLinearMcpOAuth: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/posthog-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startPostHogMcpOAuth: vi.fn(),
  completePostHogMcpOAuth: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/neon-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startNeonMcpOAuth: vi.fn(),
  completeNeonMcpOAuth: vi.fn(),
}));
vi.mock("@opencompany/agent/integrations/latitude-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startLatitudeMcpOAuth: vi.fn(),
  completeLatitudeMcpOAuth: vi.fn(),
}));

const STATE_SECRET = "mcp-state-secret-mcp-state-secret";
const sentinelDb = { sentinel: "db" };
const PROVIDERS: McpOAuthProvider[] = ["linear", "posthog", "neon", "latitude"];

// The mocked module-level start/complete wrappers, keyed like the ingress.
const flowMocks = {
  linear: { start: startLinearMcpOAuth, complete: completeLinearMcpOAuth },
  posthog: { start: startPostHogMcpOAuth, complete: completePostHogMcpOAuth },
  neon: { start: startNeonMcpOAuth, complete: completeNeonMcpOAuth },
  latitude: { start: startLatitudeMcpOAuth, complete: completeLatitudeMcpOAuth },
} as const;

function ingress(overrides: { authError?: ApiError } = {}) {
  vi.mocked(listWorkspacesForUser).mockResolvedValue([
    { workspace: { id: "workspace_1", workosOrganizationId: null }, role: "admin" },
  ] as never);
  return createMcpOAuthIngress({
    db: sentinelDb,
    identify: async () => {
      if (overrides.authError) throw overrides.authError;
      return {
        userId: "user_1",
        organizationId: null,
        method: "session",
        activeWorkspaceId: null,
        activeBrainId: null,
      };
    },
  });
}

// The factory's verifyState stays real; states are minted with the same
// body.signature format createRemoteMcpIntegration produces.
function mintState(provider: McpOAuthProvider, overrides: Record<string, unknown> = {}) {
  const payload = {
    provider,
    userWorkosId: "user_1",
    integrationId: "gint_mcp_1",
    returnTo: "/settings/integrations",
    expiresAt: Date.now() + 600_000,
    nonce: "nonce_1",
    ...overrides,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", STATE_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

describe("remote MCP OAuth ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("MCP_OAUTH_STATE_SECRET", STATE_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("starts each provider through the injected db and redirects to authorization", async () => {
    for (const provider of PROVIDERS) {
      vi.mocked(flowMocks[provider].start).mockResolvedValue({
        status: "redirect",
        redirectUrl: `https://auth.example.com/${provider}`,
      } as never);
      const response = await ingress().start(
        provider,
        new Request(
          `https://api.example.com/integrations/${provider}/start?returnTo=/settings/integrations`,
        ),
      );
      expect(response.status, provider).toBe(302);
      expect(response.headers.get("location"), provider).toBe(
        `https://auth.example.com/${provider}`,
      );
      expect(flowMocks[provider].start).toHaveBeenCalledWith({
        userWorkosId: "user_1",
        returnTo: "/settings/integrations",
        db: sentinelDb,
      });
    }
  });

  it("short-circuits an already-authorized server to the connected status", async () => {
    for (const provider of PROVIDERS) {
      vi.mocked(flowMocks[provider].start).mockResolvedValue({
        status: "connected",
        redirectUrl: null,
      } as never);
      const response = await ingress().start(
        provider,
        new Request(
          `https://api.example.com/integrations/${provider}/start?returnTo=/settings/integrations`,
        ),
      );
      expect(response.headers.get("location"), provider).toBe(
        `https://opencompany.example.com/settings/integrations?integration=${provider}&setup=connected`,
      );
    }
  });

  it("maps a start failure to start_failed", async () => {
    vi.mocked(startNeonMcpOAuth).mockRejectedValue(new Error("discovery failed"));
    const response = await ingress().start(
      "neon",
      new Request("https://api.example.com/integrations/neon/start"),
    );
    expect(response.headers.get("location")).toBe(
      "https://opencompany.example.com/settings?integration=neon&setup=error&reason=start_failed",
    );
  });

  it("redirects anonymous browsers to the web sign-in", async () => {
    const response = await ingress({
      authError: new ApiError(401, "authentication_required", "Authentication required."),
    }).start("linear", new Request("https://api.example.com/integrations/linear/start"));
    expect(response.headers.get("location")).toBe("https://opencompany.example.com/signin");
  });

  it("keeps Linear's legacy invalid-state target while the newer providers use /settings/integrations", async () => {
    for (const provider of PROVIDERS) {
      const response = await ingress().callback(
        provider,
        new Request(
          `https://api.example.com/integrations/${provider}/callback?state=garbage&code=abc`,
        ),
      );
      const expectedPath = provider === "linear" ? "/settings" : "/settings/integrations";
      expect(response.headers.get("location"), provider).toBe(
        `https://opencompany.example.com${expectedPath}?integration=${provider}&setup=error&reason=invalid_state`,
      );
      expect(flowMocks[provider].complete).not.toHaveBeenCalled();
    }
  });

  it("rejects a state minted for another user with session_mismatch", async () => {
    const state = mintState("posthog", { userWorkosId: "user_other" });
    const response = await ingress().callback(
      "posthog",
      new Request(
        `https://api.example.com/integrations/posthog/callback?state=${encodeURIComponent(state)}&code=abc`,
      ),
    );
    expect(response.headers.get("location")).toBe(
      "https://opencompany.example.com/settings/integrations?integration=posthog&setup=error&reason=session_mismatch",
    );
    expect(completePostHogMcpOAuth).not.toHaveBeenCalled();
  });

  it("maps provider denial and a missing code to their reasons", async () => {
    const state = mintState("neon");
    const denied = await ingress().callback(
      "neon",
      new Request(
        `https://api.example.com/integrations/neon/callback?state=${encodeURIComponent(state)}&error=access_denied`,
      ),
    );
    expect(new URL(denied.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "neon_denied",
    );

    const missing = await ingress().callback(
      "neon",
      new Request(
        `https://api.example.com/integrations/neon/callback?state=${encodeURIComponent(state)}`,
      ),
    );
    expect(new URL(missing.headers.get("location") ?? "").searchParams.get("reason")).toBe(
      "missing_code",
    );
    expect(completeNeonMcpOAuth).not.toHaveBeenCalled();
  });

  it("completes the callback through the injected db", async () => {
    vi.mocked(completeLatitudeMcpOAuth).mockResolvedValue(undefined as never);
    const state = mintState("latitude");
    const response = await ingress().callback(
      "latitude",
      new Request(
        `https://api.example.com/integrations/latitude/callback?state=${encodeURIComponent(state)}&code=abc`,
      ),
    );
    expect(response.headers.get("location")).toBe(
      "https://opencompany.example.com/settings/integrations?integration=latitude&setup=connected",
    );
    expect(completeLatitudeMcpOAuth).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_mcp_1",
      code: "abc",
      state,
      db: sentinelDb,
    });
  });

  it("maps a failed token exchange to token_exchange_failed", async () => {
    vi.mocked(completeLinearMcpOAuth).mockRejectedValue(new Error("exchange failed"));
    const state = mintState("linear");
    const response = await ingress().callback(
      "linear",
      new Request(
        `https://api.example.com/integrations/linear/callback?state=${encodeURIComponent(state)}&code=abc`,
      ),
    );
    expect(response.headers.get("location")).toBe(
      "https://opencompany.example.com/settings/integrations?integration=linear&setup=error&reason=token_exchange_failed",
    );
  });
});
