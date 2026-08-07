import { describe, expect, it } from "vitest";
import {
  createClaudeActionGatewayTicket,
  verifyClaudeActionGatewayTicket,
} from "./claude-action-gateway-auth";

const secret = "test-secret-at-least-long-enough";
const codexChatSessionId = "goat_codex_chat_123e4567-e89b-12d3-a456-426614174000";
const codexChatTurnId = "goat_codex_chat_turn_223e4567-e89b-12d3-a456-426614174000";

describe("Goat claude action gateway tickets", () => {
  it("round-trips a turn-bound short-lived ticket", () => {
    const signed = createClaudeActionGatewayTicket({
      codexChatSessionId,
      codexChatTurnId,
      secret,
      now: 1_000,
    });

    expect(verifyClaudeActionGatewayTicket({ ticket: signed.ticket, secret, now: 2_000 })).toEqual({
      v: 1,
      codexChatSessionId,
      codexChatTurnId,
      expiresAt: 3_601_000,
    });
  });

  it("rejects expiry, tampering, and a wrong secret", () => {
    const signed = createClaudeActionGatewayTicket({
      codexChatSessionId,
      codexChatTurnId,
      secret,
      now: 1_000,
    });

    expect(
      verifyClaudeActionGatewayTicket({ ticket: signed.ticket, secret, now: 3_601_000 }),
    ).toBeNull();
    expect(
      verifyClaudeActionGatewayTicket({ ticket: `${signed.ticket}x`, secret, now: 2_000 }),
    ).toBeNull();
    expect(
      verifyClaudeActionGatewayTicket({
        ticket: signed.ticket,
        secret: "wrong-secret-value",
        now: 2_000,
      }),
    ).toBeNull();
  });

  it("respects a custom ttlMs", () => {
    const signed = createClaudeActionGatewayTicket({
      codexChatSessionId,
      codexChatTurnId,
      secret,
      now: 1_000,
      ttlMs: 5_000,
    });

    expect(signed.expiresAt).toBe(6_000);
    expect(
      verifyClaudeActionGatewayTicket({ ticket: signed.ticket, secret, now: 6_000 }),
    ).toBeNull();
    expect(
      verifyClaudeActionGatewayTicket({ ticket: signed.ticket, secret, now: 5_999 }),
    ).not.toBeNull();
  });

  it("rejects malformed tickets", () => {
    expect(verifyClaudeActionGatewayTicket({ ticket: "not-a-ticket", secret })).toBeNull();
    expect(verifyClaudeActionGatewayTicket({ ticket: "", secret })).toBeNull();
  });
});
