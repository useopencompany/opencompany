import { describe, expect, it } from "vitest";
import { appendRuntimeEvent } from "./events";

describe("appendRuntimeEvent lease-write path", () => {
  it("normalizes a string created_at from raw db.execute into a Date", async () => {
    // The pooled pg driver can return timestamptz as a string on the raw-execute path,
    // which used to crash event serialization (`createdAt.toISOString()` is undefined).
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
    // The exact failure mode that crashed the run: this must not throw.
    expect((event?.createdAt as Date).toISOString()).toBe("2026-05-30T18:40:41.307Z");
  });
});
