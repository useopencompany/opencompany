import { getDb } from "@opencompany/db/client";
import type { User as WorkOSUser } from "@workos-inc/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncUserAndWorkspace } from "./auth";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);

function insertReturning(rows: unknown[]) {
  const chain = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(async () => rows),
  };
  return chain;
}

describe("syncUserAndWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts the WorkOS user, default workspace, and owner membership", async () => {
    const user = {
      id: "usr_user_123",
      workosUserId: "user_123",
      email: "founder@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const workspace = {
      id: "wks_usr_user_123",
      name: "Ada Lovelace's Workspace",
      createdByUserId: user.id,
      teamSize: null,
      companyUrl: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const userInsert = insertReturning([user]);
    const workspaceInsert = insertReturning([workspace]);
    const membershipInsert = {
      values: vi.fn(() => membershipInsert),
      onConflictDoNothing: vi.fn(async () => undefined),
    };
    const insert = vi
      .fn()
      .mockReturnValueOnce(userInsert)
      .mockReturnValueOnce(workspaceInsert)
      .mockReturnValueOnce(membershipInsert);

    getDbMock.mockReturnValue({ insert } as never);

    const result = await syncUserAndWorkspace({
      id: "user_123",
      email: "founder@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      profilePictureUrl: null,
    } as WorkOSUser);

    expect(result.user).toEqual(user);
    expect(result.workspace).toEqual(workspace);
    expect(insert).toHaveBeenCalledTimes(3);
    expect(membershipInsert.values).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
      updatedAt: expect.any(Date),
    });
  });
});
