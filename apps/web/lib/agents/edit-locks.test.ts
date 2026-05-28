import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireAgentEditLockForWorkspace,
  assertValidAgentEditLock,
  refreshAgentEditLockForWorkspace,
} from "./edit-locks";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);

const ownerRow = {
  agentId: "agt_123",
  userId: "usr_123",
  token: "token_123",
  expiresAt: new Date("2026-05-24T10:02:00.000Z"),
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
};

const otherOwnerRow = {
  ...ownerRow,
  userId: "usr_other",
  token: "token_other",
  email: "grace@example.com",
  firstName: "Grace",
  lastName: "Hopper",
};

function dbWithExecuteRows(...rows: unknown[][]) {
  const execute = vi.fn();
  for (const row of rows) {
    execute.mockResolvedValueOnce({ rows: row });
  }
  getDbMock.mockReturnValue({ execute } as never);
  return { execute };
}

function dbWithUpdateReturning(rows: unknown[]) {
  const returning = vi.fn(async () => rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  getDbMock.mockReturnValue({ update } as never);
  return { update, set, where, returning };
}

describe("agent edit locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acquires an empty lock", async () => {
    const { execute } = dbWithExecuteRows([ownerRow]);

    const result = await acquireAgentEditLockForWorkspace({
      agentId: "agt_123",
      workspaceId: "wks_123",
      userId: "usr_123",
    });

    expect(result).toEqual({
      status: "acquired",
      token: "token_123",
      expiresAt: "2026-05-24T10:02:00.000Z",
      owner: { id: "usr_123", name: "Ada Lovelace", email: "ada@example.com" },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("refreshes the caller's lock", async () => {
    const { execute } = dbWithExecuteRows([ownerRow]);

    const result = await refreshAgentEditLockForWorkspace({
      agentId: "agt_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      token: "token_123",
    });

    expect(result).toEqual({
      status: "acquired",
      token: "token_123",
      expiresAt: "2026-05-24T10:02:00.000Z",
      owner: { id: "usr_123", name: "Ada Lovelace", email: "ada@example.com" },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns the existing token when the same user reacquires an active lock", async () => {
    const { execute } = dbWithExecuteRows([{ ...ownerRow, token: "existing_token" }]);

    const result = await acquireAgentEditLockForWorkspace({
      agentId: "agt_123",
      workspaceId: "wks_123",
      userId: "usr_123",
    });

    expect(result).toEqual({
      status: "acquired",
      token: "existing_token",
      expiresAt: "2026-05-24T10:02:00.000Z",
      owner: { id: "usr_123", name: "Ada Lovelace", email: "ada@example.com" },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("reports a competing unexpired lock", async () => {
    const { execute } = dbWithExecuteRows([], [otherOwnerRow]);

    const result = await acquireAgentEditLockForWorkspace({
      agentId: "agt_123",
      workspaceId: "wks_123",
      userId: "usr_123",
    });

    expect(result).toEqual({
      status: "locked",
      expiresAt: "2026-05-24T10:02:00.000Z",
      owner: {
        id: "usr_other",
        name: "Grace Hopper",
        email: "grace@example.com",
      },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("replaces an expired lock", async () => {
    const { execute } = dbWithExecuteRows([ownerRow]);

    const result = await acquireAgentEditLockForWorkspace({
      agentId: "agt_123",
      workspaceId: "wks_123",
      userId: "usr_123",
    });

    expect(result.status).toBe("acquired");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects saves without a lock token", async () => {
    await expect(
      assertValidAgentEditLock({
        agentId: "agt_123",
        workspaceId: "wks_123",
        userId: "usr_123",
      }),
    ).rejects.toThrow("Agent edit lock is required. Refresh the agent and try again.");

    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("extends a valid lock during save", async () => {
    const { update, set, returning } = dbWithUpdateReturning([{ agentId: "agt_123" }]);

    await expect(
      assertValidAgentEditLock({
        agentId: "agt_123",
        workspaceId: "wks_123",
        userId: "usr_123",
        token: "token_123",
      }),
    ).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      expiresAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(returning).toHaveBeenCalledOnce();
  });

  it("rejects saves when the token is no longer valid", async () => {
    dbWithUpdateReturning([]);

    await expect(
      assertValidAgentEditLock({
        agentId: "agt_123",
        workspaceId: "wks_123",
        userId: "usr_123",
        token: "token_123",
      }),
    ).rejects.toThrow("Another editor has this agent open. Refresh the agent and try again.");
  });
});
