import { createHmac } from "node:crypto";
import { listGoatWorkspacesForUser } from "@opencompany/db/goat-workspaces";
import {
  completeGoatLatitudeMcpOAuth,
  startGoatLatitudeMcpOAuth,
} from "@opencompany/goat-agent/integrations/latitude-mcp";
import {
  completeGoatLinearMcpOAuth,
  startGoatLinearMcpOAuth,
} from "@opencompany/goat-agent/integrations/linear-mcp";
import {
  completeGoatNeonMcpOAuth,
  startGoatNeonMcpOAuth,
} from "@opencompany/goat-agent/integrations/neon-mcp";
import {
  completeGoatPostHogMcpOAuth,
  startGoatPostHogMcpOAuth,
} from "@opencompany/goat-agent/integrations/posthog-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createMcpOAuthIngress, type McpOAuthProvider } from "./mcp-oauth-ingress";

vi.mock("@opencompany/db/goat-workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listGoatWorkspacesForUser: vi.fn(),
}));
vi.mock("@opencompany/goat-agent/integrations/linear-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startGoatLinearMcpOAuth: vi.fn(),
  completeGoatLinearMcpOAuth: vi.fn(),
}));
vi.mock("@opencompany/goat-agent/integrations/posthog-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startGoatPostHogMcpOAuth: vi.fn(),
  completeGoatPostHogMcpOAuth: vi.fn(),
}));
vi.mock("@opencompany/goat-agent/integrations/neon-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startGoatNeonMcpOAuth: vi.fn(),
  completeGoatNeonMcpOAuth: vi.fn(),
}));
vi.mock("@opencompany/goat-agent/integrations/latitude-mcp", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startGoatLatitudeMcpOAuth: vi.fn(),
  completeGoatLatitudeMcpOAuth: vi.fn(),
}));

const STATE_SECRET = "mcp-state-secret-mcp-state-secret";
const sentinelDb = { sentinel: "db" };
const PROVIDERS: McpOAuthProvider[] = ["linear", "posthog", "neon", "latitude"];

// The mocked module-level start/complete wrappers, keyed like the ingress.
const flowMocks = {
  linear: { start: startGoatLinearMcpOAuth, complete: completeGoatLinearMcpOAuth },
  posthog: { start: startGoatPostHogMcpOAuth, complete: completeGoatPostHogMcpOAuth },
  neon: { start: startGoatNeonMcpOAuth, complete: completeGoatNeonMcpOAuth },
  latitude: { start: startGoatLatitudeMcpOAuth, complete: completeGoatLatitudeMcpOAuth },
} as const;

function ingress(overrides: { authError?: ApiError } = {}) {
  vi.mocked(listGoatWorkspacesForUser).mockResolvedValue([
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
// body.signature format createGoatRemoteMcpIntegration produces.
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
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://goat.example.com");
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
        `https://goat.example.com/settings/integrations?integration=${provider}&setup=connected`,
      );
    }
  });

  it("maps a start failure to start_failed", async () => {
    vi.mocked(startGoatNeonMcpOAuth).mockRejectedValue(new Error("discovery failed"));
    const response = await ingress().start(
      "neon",
      new Request("https://api.example.com/integrations/neon/start"),
    );
    expect(response.headers.get("location")).toBe(
      "https://goat.example.com/settings?integration=neon&setup=error&reason=start_failed",
    );
  });

  it("redirects anonymous browsers to the web sign-in", async () => {
    const response = await ingress({
      authError: new ApiError(401, "authentication_required", "Authentication required."),
    }).start("linear", new Request("https://api.example.com/integrations/linear/start"));
    expect(response.headers.get("location")).toBe("https://goat.example.com/signin");
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
        `https://goat.example.com${expectedPath}?integration=${provider}&setup=error&reason=invalid_state`,
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
      "https://goat.example.com/settings/integrations?integration=posthog&setup=error&reason=session_mismatch",
    );
    expect(completeGoatPostHogMcpOAuth).not.toHaveBeenCalled();
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
    expect(completeGoatNeonMcpOAuth).not.toHaveBeenCalled();
  });

  it("completes the callback through the injected db", async () => {
    vi.mocked(completeGoatLatitudeMcpOAuth).mockResolvedValue(undefined as never);
    const state = mintState("latitude");
    const response = await ingress().callback(
      "latitude",
      new Request(
        `https://api.example.com/integrations/latitude/callback?state=${encodeURIComponent(state)}&code=abc`,
      ),
    );
    expect(response.headers.get("location")).toBe(
      "https://goat.example.com/settings/integrations?integration=latitude&setup=connected",
    );
    expect(completeGoatLatitudeMcpOAuth).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_mcp_1",
      code: "abc",
      state,
      db: sentinelDb,
    });
  });

  it("maps a failed token exchange to token_exchange_failed", async () => {
    vi.mocked(completeGoatLinearMcpOAuth).mockRejectedValue(new Error("exchange failed"));
    const state = mintState("linear");
    const response = await ingress().callback(
      "linear",
      new Request(
        `https://api.example.com/integrations/linear/callback?state=${encodeURIComponent(state)}&code=abc`,
      ),
    );
    expect(response.headers.get("location")).toBe(
      "https://goat.example.com/settings/integrations?integration=linear&setup=error&reason=token_exchange_failed",
    );
  });
});
