import { describe, expect, it } from "vitest";
import { createDictationTicket, verifyDictationTicket } from "./dictation-auth";

describe("Goat dictation tickets", () => {
  it("mints short-lived user-bound tickets", () => {
    const access = createDictationTicket({
      userWorkosId: "user_1",
      secret: "test-secret",
      now: 1_000,
      ttlMs: 60_000,
    });

    expect(access.expiresAt).toBe(61_000);
    expect(
      verifyDictationTicket({
        ticket: access.ticket,
        secret: "test-secret",
        now: 2_000,
      }),
    ).toMatchObject({
      userWorkosId: "user_1",
      expiresAt: 61_000,
    });
  });

  it("rejects expired or tampered tickets", () => {
    const access = createDictationTicket({
      userWorkosId: "user_1",
      secret: "test-secret",
      now: 1_000,
      ttlMs: 60_000,
    });

    expect(
      verifyDictationTicket({
        ticket: access.ticket,
        secret: "test-secret",
        now: 61_000,
      }),
    ).toBeNull();
    expect(
      verifyDictationTicket({
        ticket: `${access.ticket}tampered`,
        secret: "test-secret",
        now: 2_000,
      }),
    ).toBeNull();
  });
});
