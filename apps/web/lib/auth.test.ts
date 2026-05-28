import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkOSClient } from "@/lib/workos";
import {
  hasCompletedOnboarding,
  loadCurrentWorkspaceContextReadOnly,
  provisionDefaultOrganization,
  syncUserAndWorkspace,
} from "./auth";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({
  refreshSession: vi.fn(),
  withAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/workos", () => ({
  getWorkOSClient: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const originalEnv = { ...process.env };

const authUser = {
  id: "user_123",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  profilePictureUrl: null,
};

const appUser = {
  id: "usr_user_123",
  workosUserId: "user_123",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const workspace = {
  id: "wks_123",
  workosOrganizationId: "org_123",
  name: "Ada's Workspace",
  createdByUserId: "usr_user_123",
  teamSize: null,
  companyUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function returningOrThenable(returningValue: unknown[]) {
  return {
    returning: vi.fn(async () => returningValue),
    then: (resolve: (value: unknown[]) => void) => Promise.resolve([]).then(resolve),
  };
}

function createDbMock(input: { selectResults: unknown[][]; insertReturningResults: unknown[][] }) {
  const selectResults = [...input.selectResults];
  const insertReturningResults = [...input.insertReturningResults];
  const insertedValues: unknown[] = [];
  const execute = vi.fn().mockResolvedValue({
    rows: [{ ledgerId: 1, amountCents: 300, balanceCents: 300 }],
  });

  const limit = vi.fn(async () => selectResults.shift() ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  const onConflictDoUpdate = vi.fn(() => returningOrThenable(insertReturningResults.shift() ?? []));
  const onConflictDoNothing = vi.fn(() =>
    returningOrThenable(insertReturningResults.shift() ?? []),
  );
  const values = vi.fn((value: unknown) => {
    insertedValues.push(value);
    return { onConflictDoUpdate, onConflictDoNothing };
  });
  const insert = vi.fn(() => ({ values }));

  return {
    db: { select, insert, execute },
    insertedValues,
    execute,
  };
}

describe("workspace organization auth sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    getWorkOSClientMock.mockReturnValue({
      organizations: {
        createOrganization: vi.fn().mockResolvedValue({
          id: "org_123",
          name: "Ada's Workspace",
        }),
        getOrganization: vi.fn().mockResolvedValue({
          id: "org_123",
          name: "Ada's Workspace",
        }),
      },
      userManagement: {
        createOrganizationMembership: vi.fn().mockResolvedValue({ id: "om_123" }),
      },
    } as never);
  });

  it("loads an existing workspace by WorkOS organization id", async () => {
    const { db, insertedValues, execute } = createDbMock({
      selectResults: [[{ id: appUser.id }], [workspace]],
      insertReturningResults: [[appUser]],
    });
    getDbMock.mockReturnValue(db as never);

    const result = await syncUserAndWorkspace(authUser as never, "org_123", "admin");

    expect(result.workspace).toEqual(workspace);
    expect(getWorkOSClientMock().organizations.getOrganization).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        workspaceId: "wks_123",
        userId: "usr_user_123",
        role: "admin",
      }),
    );
  });

  it("preserves a member WorkOS role while syncing local membership", async () => {
    const { db, insertedValues } = createDbMock({
      selectResults: [[{ id: appUser.id }], [workspace]],
      insertReturningResults: [[appUser]],
    });
    getDbMock.mockReturnValue(db as never);

    const result = await syncUserAndWorkspace(authUser as never, "org_123", "member");

    expect(result.role).toBe("member");
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        workspaceId: "wks_123",
        userId: "usr_user_123",
        role: "member",
      }),
    );
  });

  it("loads an existing workspace read-only without upserting route auth state", async () => {
    const { db, insertedValues, execute } = createDbMock({
      selectResults: [[appUser], [workspace], [{ userId: appUser.id }]],
      insertReturningResults: [],
    });
    getDbMock.mockReturnValue(db as never);

    const result = await loadCurrentWorkspaceContextReadOnly(authUser as never, "org_123");

    expect(result?.user).toEqual(appUser);
    expect(result?.workspace).toEqual(workspace);
    expect(result?.isNewUser).toBe(false);
    expect(insertedValues).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the WorkOS session role over a stale local membership role", async () => {
    const { db, insertedValues } = createDbMock({
      selectResults: [[appUser], [workspace], [{ userId: appUser.id, role: "admin" }]],
      insertReturningResults: [],
    });
    getDbMock.mockReturnValue(db as never);

    const result = await loadCurrentWorkspaceContextReadOnly(
      authUser as never,
      "org_123",
      "member",
    );

    expect(result?.role).toBe("member");
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        workspaceId: "wks_123",
        userId: "usr_user_123",
        role: "member",
      }),
    );
  });

  it("creates a default WorkOS Organization and local workspace for first sign-in", async () => {
    const { db, insertedValues, execute } = createDbMock({
      selectResults: [[], []],
      insertReturningResults: [[appUser], [workspace]],
    });
    getDbMock.mockReturnValue(db as never);

    const result = await provisionDefaultOrganization(authUser as never);

    expect(result.workspace).toEqual(workspace);
    expect(getWorkOSClientMock().organizations.createOrganization).toHaveBeenCalledWith({
      name: "Ada Lovelace's Workspace",
    });
    expect(getWorkOSClientMock().userManagement.createOrganizationMembership).toHaveBeenCalledWith({
      organizationId: "org_123",
      userId: "user_123",
      roleSlug: "admin",
    });
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        workosOrganizationId: "org_123",
        createdByUserId: "usr_user_123",
      }),
    );
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        workspaceId: "wks_123",
        userId: "usr_user_123",
        role: "admin",
      }),
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("reuses an existing default workspace without creating another WorkOS Organization", async () => {
    const { db, insertedValues, execute } = createDbMock({
      selectResults: [[{ id: appUser.id }], [workspace]],
      insertReturningResults: [[appUser]],
    });
    getDbMock.mockReturnValue(db as never);

    const result = await provisionDefaultOrganization(authUser as never);

    expect(result.workspace).toEqual(workspace);
    expect(getWorkOSClientMock().organizations.createOrganization).not.toHaveBeenCalled();
    expect(
      getWorkOSClientMock().userManagement.createOrganizationMembership,
    ).not.toHaveBeenCalled();
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        workspaceId: "wks_123",
        userId: "usr_user_123",
        role: "admin",
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("grants signup credit when a new user creates a workspace for an existing organization", async () => {
    const { db, execute } = createDbMock({
      selectResults: [[], []],
      insertReturningResults: [[appUser], [workspace]],
    });
    getDbMock.mockReturnValue(db as never);

    const result = await syncUserAndWorkspace(authUser as never, "org_123", "admin");

    expect(result.workspace).toEqual(workspace);
    expect(getWorkOSClientMock().organizations.getOrganization).toHaveBeenCalledWith("org_123");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("treats configured local bypass emails as onboarded without querying onboarding responses", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.CI;
    delete process.env.VERCEL_ENV;
    process.env.OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS = "louis@acta.so";

    await expect(
      hasCompletedOnboarding({
        id: "usr_louis",
        email: "Louis@Acta.so",
      }),
    ).resolves.toBe(true);

    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("ignores local onboarding bypass emails in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS = "louis@acta.so";
    const { db } = createDbMock({
      selectResults: [[]],
      insertReturningResults: [],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(
      hasCompletedOnboarding({
        id: "usr_louis",
        email: "louis@acta.so",
      }),
    ).resolves.toBe(false);

    expect(getDbMock).toHaveBeenCalledOnce();
  });

  it("ignores local onboarding bypass emails in CI", async () => {
    process.env.NODE_ENV = "test";
    process.env.CI = "true";
    process.env.OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS = "louis@acta.so";
    const { db } = createDbMock({
      selectResults: [[]],
      insertReturningResults: [],
    });
    getDbMock.mockReturnValue(db as never);

    await expect(
      hasCompletedOnboarding({
        id: "usr_louis",
        email: "louis@acta.so",
      }),
    ).resolves.toBe(false);

    expect(getDbMock).toHaveBeenCalledOnce();
  });
});
