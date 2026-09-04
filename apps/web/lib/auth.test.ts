import type { IdentityDto } from "@opencompany/protocol";
import { saveSession, withAuth } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeAuthentication,
  currentBrainByRef,
  currentIdentity,
  currentUser,
} from "@/lib/auth";
import { recordLastAuthMethod } from "@/lib/auth-methods";
import { serverApiClient } from "@/lib/server-api-client";
import { rememberActiveWorkspace } from "@/lib/workspace-session";

vi.mock("@workos-inc/authkit-nextjs", () => ({
  saveSession: vi.fn(),
  withAuth: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

vi.mock("react", () => ({
  cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/auth-methods", () => ({ recordLastAuthMethod: vi.fn() }));

vi.mock("@/lib/server-api-client", () => ({
  serverApiClient: vi.fn(),
  serverApiError: vi.fn(async () => new Error("identity unavailable")),
}));

vi.mock("@/lib/workspace-session", () => ({
  ACTIVE_BRAIN_COOKIE: "goat-active-brain",
  ACTIVE_WORKSPACE_COOKIE: "goat-active-workspace",
  rememberActiveWorkspace: vi.fn(),
}));

const authUser = {
  id: "user_123",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  profilePictureUrl: null,
};

const identity = {
  user: {
    id: authUser.id,
    email: authUser.email,
    firstName: authUser.firstName,
    lastName: authUser.lastName,
    avatarUrl: null,
    timezone: "Europe/London",
    taskSpawningEnabled: true,
    autoModelRoutingEnabled: false,
    chatCapabilitiesBetaEnabled: false,
    wikiEnabled: true as const,
    taskViewMode: "board" as const,
    taskTimeRange: "7d" as const,
    preferredMcpClient: "claude" as const,
    mcpSetupCompletedAt: "2026-08-13T12:00:00.000Z",
    onboardedAt: "2026-08-13T12:00:00.000Z",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
  },
  workspaces: [
    {
      id: "goat_ws_company",
      name: "Analytical Co",
      slug: "analytical-co",
      legacyBrainEnabled: true,
      role: "member" as const,
    },
  ],
  activeWorkspaceId: "goat_ws_company",
  brains: [
    {
      id: "brain_company",
      workspaceId: "goat_ws_company",
      name: "General",
      slug: "general",
      description: null,
      visibility: "workspace" as const,
      enrichmentEnabled: true,
      intelligence: "basic" as const,
    },
  ],
  activeBrainId: "brain_company",
} satisfies IdentityDto;

const serverApiClientMock = vi.mocked(serverApiClient);
const withAuthMock = vi.mocked(withAuth);
const redirectMock = vi.mocked(redirect);

function apiClient(data: IdentityDto = identity) {
  const response = () =>
    Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 })) as never;
  return {
    v1: {
      identity: Object.assign({ $get: response }, { sync: { $post: response } }),
    },
  } as never;
}

describe("completeAuthentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cookies).mockResolvedValue({
      get: vi.fn(() => ({ name: "wos-session", value: "freshly-sealed-session" })),
    } as never);
    serverApiClientMock.mockResolvedValue(apiClient());
  });

  it("synchronizes with the newly sealed browser session and activates returned browser state", async () => {
    const authResponse = {
      user: authUser,
      organizationId: "org_company",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      authenticationMethod: "MagicAuth",
    };

    await completeAuthentication(authResponse as never, "https://my.opencompany.chat");

    expect(saveSession).toHaveBeenCalledWith(authResponse, "https://my.opencompany.chat");
    expect(recordLastAuthMethod).toHaveBeenCalledWith("MagicAuth");
    expect(serverApiClientMock).toHaveBeenCalledWith({
      sessionCookie: { name: "wos-session", value: "freshly-sealed-session" },
      origin: "https://my.opencompany.chat",
    });
    expect(rememberActiveWorkspace).toHaveBeenCalledWith({
      workspaceId: "goat_ws_company",
      brainId: "brain_company",
    });
  });

  it("does not activate a workspace before onboarding creates one", async () => {
    serverApiClientMock.mockResolvedValue(
      apiClient({
        ...identity,
        workspaces: [],
        activeWorkspaceId: null,
        brains: [],
        activeBrainId: null,
      }),
    );
    await completeAuthentication(
      {
        user: authUser,
        accessToken: "access_token",
        refreshToken: "refresh_token",
        authenticationMethod: "GoogleOAuth",
      } as never,
      "https://my.opencompany.chat",
    );
    expect(rememberActiveWorkspace).not.toHaveBeenCalled();
  });

  it("fails closed instead of falling back to the incompatible access token", async () => {
    vi.mocked(cookies).mockResolvedValue({ get: vi.fn(() => undefined) } as never);

    await expect(
      completeAuthentication(
        {
          user: authUser,
          accessToken: "access_token",
          refreshToken: "refresh_token",
          authenticationMethod: "GoogleOAuth",
        } as never,
        "https://my.opencompany.chat/auth/callback",
      ),
    ).rejects.toThrow("Could not read the newly saved authentication session.");
    expect(serverApiClientMock).not.toHaveBeenCalled();
  });
});

describe("request-cached identity adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withAuthMock.mockResolvedValue({ user: authUser, organizationId: "org_company" } as never);
    serverApiClientMock.mockResolvedValue(apiClient());
  });

  it("maps the narrow identity DTO onto the established currentUser shape", async () => {
    const context = await currentUser();

    expect(context.user).toMatchObject({
      workosUserId: authUser.id,
      email: authUser.email,
      preferredMcpClient: "claude",
    });
    expect(context.user.mcpSetupCompletedAt).toEqual(new Date("2026-08-13T12:00:00.000Z"));
    expect(context.workspace).toEqual({
      id: "goat_ws_company",
      name: "Analytical Co",
      slug: "analytical-co",
      legacyBrainEnabled: true,
    });
    expect(context.activeBrain?.id).toBe("brain_company");
  });

  it("keeps authenticated users without a workspace in the identity tier", async () => {
    serverApiClientMock.mockResolvedValue(
      apiClient({
        ...identity,
        workspaces: [],
        activeWorkspaceId: null,
        brains: [],
        activeBrainId: null,
      }),
    );

    await expect(currentIdentity()).resolves.toMatchObject({ workspaces: [] });
    await currentUser();
    expect(redirectMock).toHaveBeenCalledWith("/onboarding");
  });

  it("resolves an accessible Brain by id or slug without a persistence call", async () => {
    await expect(currentBrainByRef("general")).resolves.toMatchObject({
      brain: { id: "brain_company" },
    });
    await expect(currentBrainByRef("missing")).rejects.toThrow(
      "You do not have access to that brain.",
    );
  });

  it("redirects anonymous browsers to sign in", async () => {
    withAuthMock.mockResolvedValue({ user: null } as never);
    await currentIdentity();
    expect(redirectMock).toHaveBeenCalledWith("/signin");
  });
});
