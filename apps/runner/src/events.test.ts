import { describe, expect, it } from "vitest";
import { appendRuntimeEvent, type RuntimeEventForStream, subscribeSessionEvents } from "./events";

describe("appendRuntimeEvent lease-write path", () => {
  it("normalizes a string created_at from raw db.execute into a Date", async () => {
    // The pooled pg driver can return timestamptz as a string on the raw-execute path,
    // which used to crash SSE serialization (`createdAt.toISOString()` is undefined).
    const received: RuntimeEventForStream[] = [];
    const unsubscribe = subscribeSessionEvents("ses_1", (event) => received.push(event));

    const fakeDb = {
      execute: async () => ({
        rows: [
          {
            id: 7,
            sessionId: "ses_1",
            messageId: null,
            type: "session.status",
            payload: { status: "running" },
            createdAt: "2026-05-30T18:40:41.307Z",
          },
        ],
      }),
    };

    try {
      const event = await appendRuntimeEvent(
        fakeDb as never,
        {
          sessionId: "ses_1",
          leaseId: "lease_1",
          leaseOwner: "runner-a",
          type: "session.status",
          payload: { status: "running", message: "Agent is running" },
        } as never,
      );

      expect(event?.createdAt).toBeInstanceOf(Date);
      expect(received).toHaveLength(1);
      expect(received[0]?.createdAt).toBeInstanceOf(Date);
      // The exact failure mode that crashed the run: this must not throw.
      expect((received[0]?.createdAt as Date).toISOString()).toBe("2026-05-30T18:40:41.307Z");
    } finally {
      unsubscribe();
    }
  });
});
