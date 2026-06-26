import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentConnectorOrganization } from "@/lib/auth";
import { createConnectorMcpOAuthCallbackRoute } from "./oauth-routes";

vi.mock("@/lib/auth", () => ({
  currentConnectorOrganization: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentConnectorOrganization).mockResolvedValue({
    user: { id: "cusr_123" },
    organization: { id: "corg_123" },
    membership: { role: "owner" },
  } as Awaited<ReturnType<typeof currentConnectorOrganization>>);
});

describe("connector MCP OAuth callback route", () => {
  it("rejects invalid callback state", async () => {
    const route = createConnectorMcpOAuthCallbackRoute(
      provider({
        verifyState: () => {
          throw new Error("invalid");
        },
      }),
      vi.fn(),
    );

    await expectRedirect(
      route(request("?state=bad&code=abc")),
      "https://connector.example/setup?mcp=linear&setup=error&reason=invalid_state",
    );
  });

  it("rejects callback state from a different connector session", async () => {
    const route = createConnectorMcpOAuthCallbackRoute(
      provider({
        verifyState: () => ({
          organizationId: "corg_other",
          userId: "cusr_123",
          returnTo: "/setup",
          expiresAt: Date.now() + 60_000,
          nonce: "nonce",
        }),
      }),
      vi.fn(),
    );

    await expectRedirect(
      route(request("?state=signed&code=abc")),
      "https://connector.example/setup?mcp=linear&setup=error&reason=session_mismatch",
    );
  });
});

function provider(
  overrides: Partial<Parameters<typeof createConnectorMcpOAuthCallbackRoute>[0]> = {},
): Parameters<typeof createConnectorMcpOAuthCallbackRoute>[0] {
  return {
    key: "linear",
    displayName: "Linear",
    endpointUrl: "https://mcp.linear.app/mcp",
    credentialKind: "oauth",
    callbackUrl: () => "https://connector.example/api/mcp/linear/callback",
    appendSetupStatus: (returnTo, status, reason) => {
      const params = new URLSearchParams({ mcp: "linear", setup: status });
      if (reason) params.set("reason", reason);
      return `${returnTo}?${params.toString()}`;
    },
    verifyState: vi.fn(),
    complete: vi.fn(),
    createState: vi.fn(),
    start: vi.fn(),
    startFailureStatusReason: vi.fn(() => "Linear MCP authorization could not start."),
    ...overrides,
  };
}

function request(search: string) {
  return new Request(`https://connector.example/api/mcp/linear/callback${search}`);
}

async function expectRedirect(responsePromise: Promise<Response>, location: string) {
  const response = await responsePromise;
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(location);
}
