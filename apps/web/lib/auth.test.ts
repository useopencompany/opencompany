import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkOSClient } from "@/lib/workos";
import { provisionDefaultOrganization, syncUserAndWorkspace } from "./auth";

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
    db: { select, insert },
    insertedValues,
  };
}

describe("workspace organization auth sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const { db, insertedValues } = createDbMock({
      selectResults: [[{ id: appUser.id }], [workspace]],
      insertReturningResults: [[appUser]],
    });
    getDbMock.mockReturnValue(db as never);

    const result = await syncUserAndWorkspace(authUser as never, "org_123", "admin");

    expect(result.workspace).toEqual(workspace);
    expect(getWorkOSClientMock().organizations.getOrganization).not.toHaveBeenCalled();
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        workspaceId: "wks_123",
        userId: "usr_user_123",
        role: "admin",
      }),
    );
  });

  it("creates a default WorkOS Organization and local workspace for first sign-in", async () => {
    const { db, insertedValues } = createDbMock({
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
  });

  it("reuses an existing default workspace without creating another WorkOS Organization", async () => {
    const { db, insertedValues } = createDbMock({
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
  });
});
