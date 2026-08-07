import { describe, expect, it } from "vitest";
import { createGoatDictationTicket, verifyGoatDictationTicket } from "./dictation-auth";

describe("Goat dictation tickets", () => {
  it("mints short-lived user-bound tickets", () => {
    const access = createGoatDictationTicket({
      userWorkosId: "user_1",
      secret: "test-secret",
      now: 1_000,
      ttlMs: 60_000,
    });

    expect(access.expiresAt).toBe(61_000);
    expect(
      verifyGoatDictationTicket({
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
    const access = createGoatDictationTicket({
      userWorkosId: "user_1",
      secret: "test-secret",
      now: 1_000,
      ttlMs: 60_000,
    });

    expect(
      verifyGoatDictationTicket({
        ticket: access.ticket,
        secret: "test-secret",
        now: 61_000,
      }),
    ).toBeNull();
    expect(
      verifyGoatDictationTicket({
        ticket: `${access.ticket}tampered`,
        secret: "test-secret",
        now: 2_000,
      }),
    ).toBeNull();
  });
});
