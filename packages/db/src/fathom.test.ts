import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  ensureFathomSyncState,
  listFathomPendingMeetings,
  upsertFathomPendingMeeting,
} from "./fathom";

describe("Goat Fathom persistence", () => {
  it("stores the connection-time cursor when the sync row is first created", async () => {
    const onConflictDoNothing = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const db = { insert: vi.fn(() => ({ values })) };
    const connectedAt = new Date("2026-07-16T10:00:00.000Z");

    await ensureFathomSyncState(
      {
        integrationId: "gint_123",
        userWorkosId: "user_123",
        createdAfterCursor: connectedAt,
      },
      db,
    );

    expect(values).toHaveBeenCalledWith({
      integrationId: "gint_123",
      userWorkosId: "user_123",
      createdAfterCursor: connectedAt,
    });
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it("persists unready meetings without resetting their retry history", async () => {
    const onConflictDoUpdate = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const db = { insert: vi.fn(() => ({ values })) };
    const meetingCreatedAt = new Date("2026-07-16T09:30:00.000Z");

    await upsertFathomPendingMeeting(
      {
        integrationId: "gint_123",
        recordingId: "456",
        userWorkosId: "user_123",
        meetingCreatedAt,
        rawPayload: { recording_id: 456, transcript: null },
      },
      db,
    );

    expect(values).toHaveBeenCalledWith({
      integrationId: "gint_123",
      recordingId: "456",
      userWorkosId: "user_123",
      meetingCreatedAt,
      rawPayload: { recording_id: 456, transcript: null },
    });
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.not.objectContaining({ attemptCount: expect.anything() }),
      }),
    );
  });

  it("orders never-attempted meetings before the oldest retries", async () => {
    const limit = vi.fn(async () => []);
    const orderBy = vi.fn((..._orders: unknown[]) => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };

    await listFathomPendingMeetings({ integrationId: "gint_123" }, db);

    const call = orderBy.mock.calls[0];
    if (!call) throw new Error("Expected a pending-meeting order clause.");
    const [retryOrder, createdOrder] = call as [SQL, SQL];
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(retryOrder).sql).toContain("ASC NULLS FIRST");
    expect(dialect.sqlToQuery(createdOrder).sql).toContain('"created_at" asc');
  });
});
