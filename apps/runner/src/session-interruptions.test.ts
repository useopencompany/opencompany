import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const eventMocks = vi.hoisted(() => ({ publishRuntimeEvent: vi.fn() }));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("./events", () => ({ publishRuntimeEvent: eventMocks.publishRuntimeEvent }));

import { finalizeOrphanedAbortingSessions } from "./session-interruptions";

afterEach(() => {
  vi.clearAllMocks();
});

describe("finalizeOrphanedAbortingSessions", () => {
  it("counts finalized sessions and republishes their status events to live viewers", async () => {
    const createdAt = new Date("2026-06-06T00:00:00.000Z");
    const rows = [
      {
        id: 1,
        sessionId: "ses_orphan",
        messageId: null,
        type: "session.status",
        payload: { status: "aborted" },
        createdAt,
      },
      {
        id: 2,
        sessionId: "ses_orphan",
        messageId: null,
        type: "session.aborted",
        payload: { reason: "orphaned_aborting" },
        createdAt,
      },
    ];
    const execute = vi.fn().mockResolvedValue({ rows });
    dbMocks.getDb.mockReturnValue({ execute });

    const finalized = await finalizeOrphanedAbortingSessions(new Date("2026-06-06T00:01:00.000Z"));

    // One distinct session finalized (counted by its status event, not the audit event).
    expect(finalized).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(eventMocks.publishRuntimeEvent).toHaveBeenCalledWith(
      "ses_orphan",
      expect.objectContaining({ type: "session.status", payload: { status: "aborted" } }),
    );
  });

  it("finalizes nothing when no sessions are stuck aborting", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    dbMocks.getDb.mockReturnValue({ execute });

    await expect(finalizeOrphanedAbortingSessions()).resolves.toBe(0);
    expect(eventMocks.publishRuntimeEvent).not.toHaveBeenCalled();
  });
});
