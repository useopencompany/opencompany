import { listAccessibleBrains } from "@opencompany/db/workspaces";
import type { JWTPayload, jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentUser } from "@/lib/auth";
import {
  resolveChatRequestContext,
  resolveMacChatContext,
  verifyMacAccessToken,
} from "@/lib/chat-request-auth";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(),
}));

vi.mock("@opencompany/db/workspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/db/workspaces")>();
  return {
    ...actual,
    listAccessibleBrains: vi.fn(),
  };
});

describe("resolveChatRequestContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves cookie-authenticated browser requests", async () => {
    const context = browserContext();
    vi.mocked(currentUser).mockResolvedValue(context as never);

    const result = await resolveChatRequestContext(
      new Request("https://app.example/api/chat", { method: "POST" }),
    );

    expect(result).toEqual({ ok: true, context });
    expect(currentUser).toHaveBeenCalledWith({ optional: true });
  });

  it("never falls back to cookies for a malformed authorization header", async () => {
    const result = await resolveChatRequestContext(
      new Request("https://app.example/api/chat", {
        method: "POST",
        headers: { Authorization: "Basic credentials" },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(currentUser).not.toHaveBeenCalled();
  });
});

describe("verifyMacAccessToken", () => {
  it("accepts a token issued for the configured resource", async () => {
    const verifyJwt = vi.fn(async () => ({
      payload: {
        sub: "user_1",
        org_id: "org_1",
        exp: 2_000_000_000,
      },
      protectedHeader: { alg: "RS256" },
    }));

    const result = await verifyMacAccessToken("token", {
      audience: "goat_api",
      authKitDomain: "https://example.authkit.app",
      verifyJwt: verifyJwt as unknown as typeof jwtVerify,
    });

    expect(result.ok).toBe(true);
    expect(verifyJwt).toHaveBeenCalledWith(
      "token",
      expect.any(Function),
      expect.objectContaining({
        issuer: "https://example.authkit.app",
        audience: "goat_api",
      }),
    );
  });

  it("rejects an MCP-audience token", async () => {
    const result = await verifyMacAccessToken("token", {
      audience: "goat_api",
      authKitDomain: "https://example.authkit.app",
      verifyJwt: vi.fn(async () => {
        throw new Error("unexpected audience");
      }) as unknown as typeof jwtVerify,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it.each([
    "expired",
    "wrong issuer",
    "wrong audience",
  ])("rejects tokens that fail JWT verification: %s", async () => {
    const result = await verifyMacAccessToken("token", {
      audience: "goat_api",
      authKitDomain: "https://example.authkit.app",
      verifyJwt: vi.fn(async () => {
        throw new Error("JWT verification failed");
      }) as unknown as typeof jwtVerify,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("fails closed when the resource audience is missing", async () => {
    const result = await verifyMacAccessToken("token", {
      audience: "",
      authKitDomain: "https://example.authkit.app",
      verifyJwt: vi.fn() as unknown as typeof jwtVerify,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });
});

describe("resolveMacChatContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAccessibleBrains).mockResolvedValue([generalBrain(), restrictedBrain()]);
  });

  it("resolves the token organization and selects its General brain", async () => {
    const result = await resolveMacChatContext(validPayload(), mockDb({}));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.user.workosUserId).toBe("user_1");
    expect(result.context.workspace.id).toBe("workspace_1");
    expect(result.context.role).toBe("admin");
    expect(result.context.activeBrain?.id).toBe("brain_general");
    expect(listAccessibleBrains).toHaveBeenCalledWith(
      { userWorkosId: "user_1", workspaceId: "workspace_1" },
      expect.objectContaining({ db: expect.any(Object) }),
    );
  });

  it("rejects missing user and organization claims", async () => {
    const result = await resolveMacChatContext({ sub: "user_1" }, mockDb({}));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("requires an existing onboarded user", async () => {
    const missing = await resolveMacChatContext(validPayload(), mockDb({ user: null }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.response.status).toBe(403);

    const incomplete = await resolveMacChatContext(
      validPayload(),
      mockDb({ user: user({ onboardedAt: null }) }),
    );
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) await expect(incomplete.response.text()).resolves.toContain("onboarding");
  });

  it("rejects an organization without a matching workspace membership", async () => {
    const result = await resolveMacChatContext(validPayload(), mockDb({ membership: null }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("requires an accessible brain", async () => {
    vi.mocked(listAccessibleBrains).mockResolvedValue([]);

    const result = await resolveMacChatContext(validPayload(), mockDb({}));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("falls back to the first accessible brain when General is unavailable", async () => {
    vi.mocked(listAccessibleBrains).mockResolvedValue([restrictedBrain()]);

    const result = await resolveMacChatContext(validPayload(), mockDb({}));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.activeBrain?.id).toBe("brain_other");
  });
});

function validPayload(): JWTPayload {
  return {
    sub: "user_1",
    org_id: "org_1",
    exp: 2_000_000_000,
  };
}

function mockDb(input: {
  user?: ReturnType<typeof user> | null;
  membership?: ReturnType<typeof workspaceMembership> | null;
}) {
  const rows = [
    input.user === null ? [] : [input.user ?? user()],
    input.membership === null ? [] : [input.membership ?? workspaceMembership()],
  ];
  const select = vi.fn(() => {
    const result = rows.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async () => result);
    return chain;
  });
  return { select } as never;
}

function user(overrides: { onboardedAt?: Date | null } = {}) {
  return {
    workosUserId: "user_1",
    email: "user@example.com",
    firstName: "Goat",
    lastName: "User",
    avatarUrl: null,
    timezone: "UTC",
    taskSpawningEnabled: true,
    autoModelRoutingEnabled: false,
    chatCapabilitiesBetaEnabled: false,
    preferredMcpClient: null,
    mcpSetupCompletedAt: null,
    onboardedAt: overrides.onboardedAt === undefined ? new Date() : overrides.onboardedAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function workspaceMembership() {
  return {
    workspace: {
      id: "workspace_1",
      workosOrganizationId: "org_1",
      name: "Workspace",
      slug: "workspace",
      createdByWorkosId: "user_1",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    role: "admin" as const,
  };
}

function generalBrain() {
  return {
    id: "brain_general",
    workspaceId: "workspace_1",
    name: "General",
    slug: "general",
    description: null,
    visibility: "workspace" as const,
    enrichmentEnabled: true,
    intelligence: "basic" as const,
    createdByWorkosId: "user_1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function restrictedBrain() {
  return {
    ...generalBrain(),
    id: "brain_other",
    name: "Other",
    slug: "other",
  };
}

function browserContext() {
  const membership = workspaceMembership();
  const brain = generalBrain();
  return {
    user: user(),
    workspace: membership.workspace,
    role: membership.role,
    workspaces: [membership],
    brains: [brain],
    activeBrain: brain,
  };
}
