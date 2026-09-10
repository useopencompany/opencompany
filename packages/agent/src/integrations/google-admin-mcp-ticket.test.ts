import { describe, expect, it } from "vitest";
import { createGoogleAdminMcpTicket, verifyGoogleAdminMcpTicket } from "./google-admin-mcp-ticket";
import { verifyGoogleCalendarMcpTicket } from "./google-calendar-mcp-ticket";

const input = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  integrationId: "integration_1",
  registrationId: "registration_1",
  operation: { type: "tools/call", tool: "create_user", capability: "write" } as const,
  secret: "test-secret-at-least-long-enough",
  now: 1_000,
  ttlMs: 500,
};

describe("Google Admin MCP tickets", () => {
  it("round-trips a narrowly scoped signed capability", () => {
    const created = createGoogleAdminMcpTicket(input);
    expect(created.expiresAt).toBe(1_500);
    expect(
      verifyGoogleAdminMcpTicket({ ticket: created.ticket, secret: input.secret, now: 1_499 }),
    ).toMatchObject({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      operation: { type: "tools/call", tool: "create_user", capability: "write" },
    });
  });

  it("cannot authenticate as another first-party Google adapter", () => {
    const { ticket } = createGoogleAdminMcpTicket(input);
    expect(verifyGoogleCalendarMcpTicket({ ticket, secret: input.secret, now: 1100 })).toBeNull();
  });

  it("rejects expired, tampered, incorrectly signed, and oversized tickets", () => {
    const { ticket } = createGoogleAdminMcpTicket(input);
    expect(verifyGoogleAdminMcpTicket({ ticket, secret: input.secret, now: 1_500 })).toBeNull();
    expect(
      verifyGoogleAdminMcpTicket({ ticket: `${ticket}x`, secret: input.secret, now: 1_100 }),
    ).toBeNull();
    expect(verifyGoogleAdminMcpTicket({ ticket, secret: "wrong-secret", now: 1_100 })).toBeNull();
    expect(
      verifyGoogleAdminMcpTicket({ ticket: "x".repeat(4_097), secret: input.secret }),
    ).toBeNull();
  });
});
