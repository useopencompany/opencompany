import { getDb } from "@opencompany/db/client";
import { goatUsers } from "@opencompany/db/goat-schema";
import { recordGoatSignup } from "@opencompany/goat-observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncGoatUser } from "@/lib/auth";

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
const recordGoatSignupMock = vi.mocked(recordGoatSignup);

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
