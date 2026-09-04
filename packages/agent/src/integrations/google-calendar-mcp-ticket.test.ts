import { describe, expect, it } from "vitest";
import {
  createGoogleCalendarMcpTicket,
  verifyGoogleCalendarMcpTicket,
} from "./google-calendar-mcp-ticket";

const input = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  integrationId: "integration_1",
  registrationId: "registration_1",
  operation: { type: "tools/call", tool: "create_event", capability: "write" } as const,
  secret: "test-secret-at-least-long-enough",
  now: 1_000,
  ttlMs: 500,
};

describe("Google Calendar MCP tickets", () => {
  it("round-trips a narrowly scoped signed capability", () => {
    const created = createGoogleCalendarMcpTicket(input);
    expect(created.expiresAt).toBe(1_500);
    expect(
      verifyGoogleCalendarMcpTicket({ ticket: created.ticket, secret: input.secret, now: 1_499 }),
    ).toMatchObject({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      operation: { type: "tools/call", tool: "create_event", capability: "write" },
    });
  });

  it("rejects expired, tampered, incorrectly signed, and oversized tickets", () => {
    const { ticket } = createGoogleCalendarMcpTicket(input);
    expect(verifyGoogleCalendarMcpTicket({ ticket, secret: input.secret, now: 1_500 })).toBeNull();
    expect(
      verifyGoogleCalendarMcpTicket({ ticket: `${ticket}x`, secret: input.secret, now: 1_100 }),
    ).toBeNull();
    expect(
      verifyGoogleCalendarMcpTicket({ ticket, secret: "wrong-secret", now: 1_100 }),
    ).toBeNull();
    expect(
      verifyGoogleCalendarMcpTicket({ ticket: "x".repeat(4_097), secret: input.secret }),
    ).toBeNull();
  });
});
