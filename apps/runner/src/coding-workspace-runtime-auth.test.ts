import { describe, expect, it } from "vitest";
import {
  createCodingWorkspacePreviewCapability,
  createCodingWorkspaceTicket,
  verifyCodingWorkspacePreviewCapability,
  verifyCodingWorkspaceTicket,
} from "./coding-workspace-runtime-auth";

const secret = "test-secret-at-least-long-enough";
const codingSessionId = "goat_codex_chat_123e4567-e89b-12d3-a456-426614174000";

describe("Goat coding workspace tickets", () => {
  it("round-trips an owner-bound short-lived ticket", () => {
    const signed = createCodingWorkspaceTicket({
      codingSessionId,
      userWorkosId: "user_123",
      secret,
      now: 1_000,
    });

    expect(verifyCodingWorkspaceTicket({ ticket: signed.ticket, secret, now: 2_000 })).toEqual({
      v: 1,
      codingSessionId,
      userWorkosId: "user_123",
      expiresAt: 61_000,
    });
  });

  it("rejects expiry and tampering", () => {
    const signed = createCodingWorkspaceTicket({
      codingSessionId,
      userWorkosId: "user_123",
      secret,
      now: 1_000,
    });

    expect(verifyCodingWorkspaceTicket({ ticket: signed.ticket, secret, now: 61_000 })).toBeNull();
    expect(
      verifyCodingWorkspaceTicket({ ticket: `${signed.ticket}x`, secret, now: 2_000 }),
    ).toBeNull();
  });
});

describe("Goat coding workspace preview capabilities", () => {
  it("fits in one DNS label and round-trips the session, port, and expiry", () => {
    const signed = createCodingWorkspacePreviewCapability({
      codingSessionId,
      port: 3_000,
      secret,
      now: 1_000,
    });

    expect(signed.capability.length).toBeLessThanOrEqual(63);
    expect(signed.capability).toMatch(/^[a-z2-7]+$/);
    expect(
      verifyCodingWorkspacePreviewCapability({
        capability: signed.capability,
        secret,
        now: 2_000,
      }),
    ).toEqual({ codingSessionId, port: 3_000, expiresAt: 28_801_000 });
  });

  it("rejects tampering, expiry, invalid session ids, and invalid ports", () => {
    const signed = createCodingWorkspacePreviewCapability({
      codingSessionId,
      port: 3_000,
      secret,
      now: 1_000,
    });
    const tampered = `${signed.capability.slice(0, -1)}${signed.capability.endsWith("a") ? "b" : "a"}`;

    expect(
      verifyCodingWorkspacePreviewCapability({
        capability: tampered,
        secret,
        now: 2_000,
      }),
    ).toBeNull();
    expect(
      verifyCodingWorkspacePreviewCapability({
        capability: signed.capability,
        secret,
        now: signed.expiresAt,
      }),
    ).toBeNull();
    expect(() =>
      createCodingWorkspacePreviewCapability({
        codingSessionId: "goat_codex_chat_not-a-uuid",
        port: 3_000,
        secret,
      }),
    ).toThrow(/valid UUID/);
    expect(() =>
      createCodingWorkspacePreviewCapability({ codingSessionId, port: 0, secret }),
    ).toThrow(/Preview port/);
  });
});
