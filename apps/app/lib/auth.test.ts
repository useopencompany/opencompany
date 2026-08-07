import { getDb } from "@opencompany/db/client";
import { users } from "@opencompany/db/schema";
import {
  adoptWorkspaceMembershipsFromOrgs,
  listAccessibleBrains,
  listWorkspacesForUser,
} from "@opencompany/db/workspaces";
import { recordSignup } from "@opencompany/telemetry";
import { saveSession, withAuth } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_BRAIN_COOKIE,
  ACTIVE_WORKSPACE_COOKIE,
  activateWorkspaceForOrganization,
  adoptWorkOSOrganizationMemberships,
  completeAuthentication,
  currentUser,
  syncUser,
} from "@/lib/auth";
import { recordLastAuthMethod } from "@/lib/auth-methods";
import { getWorkOSClient } from "@/lib/workos-client";
import { ensureWorkspaceOrganizationsForEntries } from "@/lib/workos-organizations";

const analyticsMocks = vi.hoisted(() => ({
  captureServerEvent: vi.fn(async () => {}),
}));

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: analyticsMocks.captureServerEvent,
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/db/workspaces", () => ({
  adoptWorkspaceMembershipsFromOrgs: vi.fn(),
  createDefaultWorkspaceForUser: vi.fn(),
  DEFAULT_BRAIN_SLUG: "default",
  getBrainAccess: vi.fn(),
  listAccessibleBrains: vi.fn(),
  listWorkspacesForUser: vi.fn(),
}));

vi.mock("@opencompany/telemetry", () => ({
  recordSignup: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({
  saveSession: vi.fn(),
  withAuth: vi.fn(),
}));

vi.mock("@/lib/auth-methods", () => ({
  recordLastAuthMethod: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("react", () => ({
  cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

vi.mock("@/lib/billing/seats", () => ({
  syncStripeSeatQuantityForWorkspace: vi.fn().mockResolvedValue({ ok: true, changed: false }),
}));

vi.mock("@/lib/workos-organizations", () => ({
  ensureWorkspaceOrganizationsForEntries: vi.fn((entries) => entries),
}));

const getDbMock = vi.mocked(getDb);
const adoptWorkspaceMembershipsFromOrgsMock = vi.mocked(adoptWorkspaceMembershipsFromOrgs);
const cookiesMock = vi.mocked(cookies);
const ensureWorkspaceOrganizationsForEntriesMock = vi.mocked(
  ensureWorkspaceOrganizationsForEntries,
);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const listAccessibleBrainsMock = vi.mocked(listAccessibleBrains);
const listWorkspacesForUserMock = vi.mocked(listWorkspacesForUser);
const recordSignupMock = vi.mocked(recordSignup);
const withAuthMock = vi.mocked(withAuth);
const saveSessionMock = vi.mocked(saveSession);
const recordLastAuthMethodMock = vi.mocked(recordLastAuthMethod);

const now = new Date("2026-01-01T00:00:00.000Z");
const authUser = {
  id: "user_123",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  profilePictureUrl: null,
};

const user = {
  workosUserId: authUser.id,
  email: authUser.email,
  firstName: authUser.firstName,
  lastName: authUser.lastName,
  avatarUrl: authUser.profilePictureUrl,
  timezone: "America/Los_Angeles",
  taskSpawningEnabled: false,
  createdAt: now,
  updatedAt: now,
};

function createDbMock(input: { insertReturning: unknown[]; updateReturning?: unknown[] }) {
  const insertReturning = vi.fn(async () => input.insertReturning);
  const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  const updateReturning = vi.fn(async () => input.updateReturning ?? []);
  const where = vi.fn(() => ({ returning: updateReturning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { insert, update },
    insert,
    values,
    onConflictDoNothing,
    insertReturning,
    update,
    set,
    where,
    updateReturning,
  };
}

describe("syncUser", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a signup when user sync creates the user row", async () => {
    const dbMock = createDbMock({ insertReturning: [user] });
    getDbMock.mockReturnValue(dbMock.db as never);

    const result = await syncUser(authUser as never);

    expect(result).toBe(user);
    expect(dbMock.insert).toHaveBeenCalledWith(users);
    expect(dbMock.values).toHaveBeenCalledWith({
      workosUserId: authUser.id,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      avatarUrl: authUser.profilePictureUrl,
      updatedAt: now,
    });
    expect(dbMock.onConflictDoNothing).toHaveBeenCalledWith({ target: users.workosUserId });
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(recordSignupMock).toHaveBeenCalledOnce();
    expect(recordSignupMock).toHaveBeenCalledWith({ source: "user_sync" });
    expect(analyticsMocks.captureServerEvent).toHaveBeenCalledWith(
      "signup_completed",
      authUser.id,
      { source: "user_sync" },
      {
        email: authUser.email,
        firstName: authUser.firstName,
        lastName: authUser.lastName,
      },
    );
  });

  it("updates an existing user without recording another signup", async () => {
    const updatedUser = { ...user, firstName: "Augusta" };
    const dbMock = createDbMock({ insertReturning: [], updateReturning: [updatedUser] });
    getDbMock.mockReturnValue(dbMock.db as never);

    const result = await syncUser({ ...authUser, firstName: "Augusta" } as never);

    expect(result).toBe(updatedUser);
    expect(dbMock.update).toHaveBeenCalledWith(users);
    expect(dbMock.set).toHaveBeenCalledWith({
      email: authUser.email,
      firstName: "Augusta",
      lastName: authUser.lastName,
      avatarUrl: authUser.profilePictureUrl,
      updatedAt: now,
    });
    expect(recordSignupMock).not.toHaveBeenCalled();
    expect(analyticsMocks.captureServerEvent).not.toHaveBeenCalled();
  });

  it("throws when neither insert nor update returns a user", async () => {
    const dbMock = createDbMock({ insertReturning: [], updateReturning: [] });
    getDbMock.mockReturnValue(dbMock.db as never);

    await expect(syncUser(authUser as never)).rejects.toThrow("Unable to sync the user.");
    expect(recordSignupMock).not.toHaveBeenCalled();
  });
});

describe("adoptWorkOSOrganizationMemberships", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports all active workspace memberships returned by WorkOS", async () => {
    const listOrganizationMemberships = vi.fn(async () => ({
      data: [
        { organizationId: "org_personal", role: { slug: "admin" } },
        { organizationId: "org_invited", role: { slug: "member" } },
      ],
    }));
    getWorkOSClientMock.mockReturnValue({
      userManagement: { listOrganizationMemberships },
    } as never);

    await adoptWorkOSOrganizationMemberships(authUser as never);

    expect(listOrganizationMemberships).toHaveBeenCalledWith({
      userId: authUser.id,
      statuses: ["active"],
    });
    expect(adoptWorkspaceMembershipsFromOrgsMock).toHaveBeenCalledWith({
      userWorkosId: authUser.id,
      memberships: [
        { organizationId: "org_personal", role: "admin" },
        { organizationId: "org_invited", role: "member" },
      ],
    });
  });

  it("does not block authentication when WorkOS membership lookup fails", async () => {
    const error = new Error("WorkOS unavailable");
    getWorkOSClientMock.mockReturnValue({
      userManagement: {
        listOrganizationMemberships: vi.fn(async () => {
          throw error;
        }),
      },
    } as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(adoptWorkOSOrganizationMemberships(authUser as never)).resolves.toBeUndefined();

    expect(adoptWorkspaceMembershipsFromOrgsMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[app] Failed to adopt WorkOS organization memberships",
      error,
    );
  });
});

describe("activateWorkspaceForOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("activates the workspace and default brain mapped to the authenticated organization", async () => {
    listWorkspacesForUserMock.mockResolvedValue([
      {
        workspace: {
          id: "goat_ws_personal",
          workosOrganizationId: "org_personal",
        },
        role: "admin",
      },
      {
        workspace: {
          id: "goat_ws_invited",
          workosOrganizationId: "org_invited",
        },
        role: "member",
      },
    ] as never);
    listAccessibleBrainsMock.mockResolvedValue([
      { id: "brain_other", slug: "other" },
      { id: "brain_default", slug: "default" },
    ] as never);
    const cookieStore = {
      set: vi.fn(),
      delete: vi.fn(),
    };
    cookiesMock.mockResolvedValue(cookieStore as never);

    await expect(
      activateWorkspaceForOrganization({
        userWorkosId: authUser.id,
        organizationId: "org_invited",
      }),
    ).resolves.toBe(true);

    expect(listAccessibleBrainsMock).toHaveBeenCalledWith({
      userWorkosId: authUser.id,
      workspaceId: "goat_ws_invited",
    });
    expect(cookieStore.set).toHaveBeenNthCalledWith(1, ACTIVE_WORKSPACE_COOKIE, "goat_ws_invited", {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
    expect(cookieStore.set).toHaveBeenNthCalledWith(2, ACTIVE_BRAIN_COOKIE, "brain_default", {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });

  it("does not change cookies when the organization has no accessible workspace", async () => {
    listWorkspacesForUserMock.mockResolvedValue([
      {
        workspace: {
          id: "goat_ws_personal",
          workosOrganizationId: "org_personal",
        },
        role: "admin",
      },
    ] as never);

    await expect(
      activateWorkspaceForOrganization({
        userWorkosId: authUser.id,
        organizationId: "org_legacy_web",
      }),
    ).resolves.toBe(false);

    expect(listAccessibleBrainsMock).not.toHaveBeenCalled();
    expect(cookiesMock).not.toHaveBeenCalled();
  });

  it("clears a stale active brain when the invited workspace has no accessible brain", async () => {
    listWorkspacesForUserMock.mockResolvedValue([
      {
        workspace: {
          id: "goat_ws_invited",
          workosOrganizationId: "org_invited",
        },
        role: "member",
      },
    ] as never);
    listAccessibleBrainsMock.mockResolvedValue([]);
    const cookieStore = {
      set: vi.fn(),
      delete: vi.fn(),
    };
    cookiesMock.mockResolvedValue(cookieStore as never);

    await activateWorkspaceForOrganization({
      userWorkosId: authUser.id,
      organizationId: "org_invited",
    });

    expect(cookieStore.set).toHaveBeenCalledWith(
      ACTIVE_WORKSPACE_COOKIE,
      "goat_ws_invited",
      expect.any(Object),
    );
    expect(cookieStore.delete).toHaveBeenCalledWith(ACTIVE_BRAIN_COOKIE);
  });
});

describe("completeAuthentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockSyncAndAdopt() {
    const dbMock = createDbMock({ insertReturning: [user] });
    getDbMock.mockReturnValue(dbMock.db as never);
    getWorkOSClientMock.mockReturnValue({
      userManagement: {
        listOrganizationMemberships: vi.fn(async () => ({ data: [] })),
      },
    } as never);
    return dbMock;
  }

  it("seals the session, records the auth method, and activates the invited workspace", async () => {
    mockSyncAndAdopt();
    listWorkspacesForUserMock.mockResolvedValue([
      {
        workspace: { id: "goat_ws_invited", workosOrganizationId: "org_invited" },
        role: "member",
      },
    ] as never);
    listAccessibleBrainsMock.mockResolvedValue([{ id: "brain_default", slug: "default" }] as never);
    const cookieStore = { set: vi.fn(), delete: vi.fn() };
    cookiesMock.mockResolvedValue(cookieStore as never);

    const authResponse = {
      user: authUser,
      organizationId: "org_invited",
      accessToken: "at_123",
      refreshToken: "rt_123",
      authenticationMethod: "MagicAuth",
    };

    await completeAuthentication(authResponse as never, "https://my.opencompany.chat");

    expect(saveSessionMock).toHaveBeenCalledWith(authResponse, "https://my.opencompany.chat");
    expect(recordLastAuthMethodMock).toHaveBeenCalledWith("MagicAuth");
    expect(cookieStore.set).toHaveBeenCalledWith(
      "goat-active-workspace",
      "goat_ws_invited",
      expect.any(Object),
    );
  });

  it("skips workspace activation when the auth response has no organization", async () => {
    mockSyncAndAdopt();

    const authResponse = {
      user: authUser,
      accessToken: "at_123",
      refreshToken: "rt_123",
      authenticationMethod: "GoogleOAuth",
    };

    await completeAuthentication(authResponse as never, "https://my.opencompany.chat");

    expect(listWorkspacesForUserMock).not.toHaveBeenCalled();
  });

  it("does not block authentication when workspace activation fails", async () => {
    mockSyncAndAdopt();
    listWorkspacesForUserMock.mockRejectedValue(new Error("Database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const authResponse = {
      user: authUser,
      organizationId: "org_invited",
      accessToken: "at_123",
      refreshToken: "rt_123",
      authenticationMethod: "MagicAuth",
    };

    await expect(
      completeAuthentication(authResponse as never, "https://my.opencompany.chat"),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "[app] Failed to activate the authenticated workspace",
      expect.any(Error),
    );
  });
});

describe("currentUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the organization selected in the WorkOS session over the local cookie", async () => {
    const workspaces = [
      {
        workspace: {
          id: "goat_ws_personal",
          workosOrganizationId: "org_personal",
          name: "Personal",
        },
        role: "admin",
      },
      {
        workspace: {
          id: "goat_ws_company",
          workosOrganizationId: "org_company",
          name: "Analytical Co",
        },
        role: "member",
      },
    ];
    const selectedBrain = { id: "brain_company", slug: "general" };
    const limit = vi.fn(async () => [user]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    getDbMock.mockReturnValue({ select } as never);
    withAuthMock.mockResolvedValue({
      user: authUser,
      organizationId: "org_company",
    } as never);
    listWorkspacesForUserMock.mockResolvedValue(workspaces as never);
    ensureWorkspaceOrganizationsForEntriesMock.mockResolvedValue(workspaces as never);
    listAccessibleBrainsMock.mockResolvedValue([selectedBrain] as never);
    cookiesMock.mockResolvedValue({
      get: vi.fn(() => ({ value: "goat_ws_personal" })),
    } as never);

    const result = await currentUser();

    expect(result.workspace.id).toBe("goat_ws_company");
    expect(result.role).toBe("member");
    expect(result.activeBrain).toBe(selectedBrain);
    expect(listAccessibleBrainsMock).toHaveBeenCalledWith({
      userWorkosId: authUser.id,
      workspaceId: "goat_ws_company",
    });
  });
});
