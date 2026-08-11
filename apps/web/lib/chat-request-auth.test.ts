import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { resolveGoatChatRequestContext } from "@/lib/chat-request-auth";

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

describe("resolveGoatChatRequestContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves cookie-authenticated browser requests", async () => {
    const context = browserContext();
    vi.mocked(currentGoatUser).mockResolvedValue(context as never);

    const result = await resolveGoatChatRequestContext(
      new Request("https://goat.example/api/chat", { method: "POST" }),
    );

    expect(result).toEqual({ ok: true, context });
    expect(currentGoatUser).toHaveBeenCalledWith({ optional: true });
  });

  it("rejects requests without a browser session", async () => {
    vi.mocked(currentGoatUser).mockResolvedValue(null as never);

    const result = await resolveGoatChatRequestContext(
      new Request("https://goat.example/api/chat", { method: "POST" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("ignores an authorization header and still resolves the browser session", async () => {
    const context = browserContext();
    vi.mocked(currentGoatUser).mockResolvedValue(context as never);

    const result = await resolveGoatChatRequestContext(
      new Request("https://goat.example/api/chat", {
        method: "POST",
        headers: { Authorization: "Bearer some-token" },
      }),
    );

    expect(result).toEqual({ ok: true, context });
    expect(currentGoatUser).toHaveBeenCalledWith({ optional: true });
  });
});

function goatUser() {
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
    onboardedAt: new Date(),
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

function browserContext() {
  const membership = workspaceMembership();
  const brain = generalBrain();
  return {
    user: goatUser(),
    workspace: membership.workspace,
    role: membership.role,
    workspaces: [membership],
    brains: [brain],
    activeBrain: brain,
  };
}
