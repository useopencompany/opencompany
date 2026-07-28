import { getDb } from "@opencompany/db/client";
import { goatUsers } from "@opencompany/db/goat-schema";
import {
  adoptGoatWorkspaceMembershipsFromOrgs,
  listAccessibleGoatBrains,
  listGoatWorkspacesForUser,
} from "@opencompany/db/goat-workspaces";
import { recordGoatSignup } from "@opencompany/goat-observability";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptWorkOSOrganizationMemberships, currentGoatUser, syncGoatUser } from "@/lib/auth";
import { getWorkOSClient } from "@/lib/workos-client";
import { ensureGoatWorkspaceOrganizationsForEntries } from "@/lib/workos-organizations";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/db/goat-workspaces", () => ({
  adoptGoatWorkspaceMembershipsFromOrgs: vi.fn(),
  createDefaultGoatWorkspaceForUser: vi.fn(),
  DEFAULT_GOAT_BRAIN_SLUG: "default",
  getGoatBrainAccess: vi.fn(),
  listAccessibleGoatBrains: vi.fn(),
  listGoatWorkspacesForUser: vi.fn(),
}));

vi.mock("@opencompany/goat-observability", () => ({
  recordGoatSignup: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: vi.fn(),
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

vi.mock("@/lib/workos-organizations", () => ({
  ensureGoatWorkspaceOrganizationsForEntries: vi.fn((entries) => entries),
}));

const getDbMock = vi.mocked(getDb);
const adoptGoatWorkspaceMembershipsFromOrgsMock = vi.mocked(adoptGoatWorkspaceMembershipsFromOrgs);
const cookiesMock = vi.mocked(cookies);
const ensureGoatWorkspaceOrganizationsForEntriesMock = vi.mocked(
  ensureGoatWorkspaceOrganizationsForEntries,
);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const listAccessibleGoatBrainsMock = vi.mocked(listAccessibleGoatBrains);
const listGoatWorkspacesForUserMock = vi.mocked(listGoatWorkspacesForUser);
const recordGoatSignupMock = vi.mocked(recordGoatSignup);
const withAuthMock = vi.mocked(withAuth);

const now = new Date("2026-01-01T00:00:00.000Z");
const authUser = {
  id: "user_123",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  profilePictureUrl: null,
};

const goatUser = {
  workosUserId: authUser.id,
  email: authUser.email,
  firstName: authUser.firstName,
  lastName: authUser.lastName,
  avatarUrl: authUser.profilePictureUrl,
  timezone: "America/Los_Angeles",
  taskSpawningEnabled: false,
  localCodexBetaEnabled: false,
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

describe("syncGoatUser", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a Goat signup when user sync creates the user row", async () => {
    const dbMock = createDbMock({ insertReturning: [goatUser] });
    getDbMock.mockReturnValue(dbMock.db as never);

    const result = await syncGoatUser(authUser as never);

    expect(result).toBe(goatUser);
    expect(dbMock.insert).toHaveBeenCalledWith(goatUsers);
    expect(dbMock.values).toHaveBeenCalledWith({
      workosUserId: authUser.id,
      email: authUser.email,
      firstName: authUser.firstName,
      lastName: authUser.lastName,
      avatarUrl: authUser.profilePictureUrl,
      updatedAt: now,
    });
    expect(dbMock.onConflictDoNothing).toHaveBeenCalledWith({ target: goatUsers.workosUserId });
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(recordGoatSignupMock).toHaveBeenCalledOnce();
    expect(recordGoatSignupMock).toHaveBeenCalledWith({ source: "user_sync" });
  });

  it("updates an existing Goat user without recording another signup", async () => {
    const updatedUser = { ...goatUser, firstName: "Augusta" };
    const dbMock = createDbMock({ insertReturning: [], updateReturning: [updatedUser] });
    getDbMock.mockReturnValue(dbMock.db as never);

    const result = await syncGoatUser({ ...authUser, firstName: "Augusta" } as never);

    expect(result).toBe(updatedUser);
    expect(dbMock.update).toHaveBeenCalledWith(goatUsers);
    expect(dbMock.set).toHaveBeenCalledWith({
      email: authUser.email,
      firstName: "Augusta",
      lastName: authUser.lastName,
      avatarUrl: authUser.profilePictureUrl,
      updatedAt: now,
    });
    expect(recordGoatSignupMock).not.toHaveBeenCalled();
  });

  it("throws when neither insert nor update returns a user", async () => {
    const dbMock = createDbMock({ insertReturning: [], updateReturning: [] });
    getDbMock.mockReturnValue(dbMock.db as never);

    await expect(syncGoatUser(authUser as never)).rejects.toThrow("Unable to sync the Goat user.");
    expect(recordGoatSignupMock).not.toHaveBeenCalled();
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
    expect(adoptGoatWorkspaceMembershipsFromOrgsMock).toHaveBeenCalledWith({
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

    expect(adoptGoatWorkspaceMembershipsFromOrgsMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[goat] Failed to adopt WorkOS organization memberships",
      error,
    );
  });
});

describe("currentGoatUser", () => {
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
    const limit = vi.fn(async () => [goatUser]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    getDbMock.mockReturnValue({ select } as never);
    withAuthMock.mockResolvedValue({
      user: authUser,
      organizationId: "org_company",
    } as never);
    listGoatWorkspacesForUserMock.mockResolvedValue(workspaces as never);
    ensureGoatWorkspaceOrganizationsForEntriesMock.mockResolvedValue(workspaces as never);
    listAccessibleGoatBrainsMock.mockResolvedValue([selectedBrain] as never);
    cookiesMock.mockResolvedValue({
      get: vi.fn(() => ({ value: "goat_ws_personal" })),
    } as never);

    const result = await currentGoatUser();

    expect(result.workspace.id).toBe("goat_ws_company");
    expect(result.role).toBe("member");
    expect(result.activeBrain).toBe(selectedBrain);
    expect(listAccessibleGoatBrainsMock).toHaveBeenCalledWith({
      userWorkosId: authUser.id,
      workspaceId: "goat_ws_company",
    });
  });
});
