import { describe, expect, it } from "vitest";
import { createGmailMcpTicket, verifyGmailMcpTicket } from "./gmail-mcp-ticket";
import { createGoogleCalendarMcpTicket } from "./google-calendar-mcp-ticket";

const input = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  integrationId: "gint_gmail",
  registrationId: "plugin_gateway_1",
  operation: { type: "tools/call", tool: "create_draft", capability: "draft" } as const,
  secret: "shared-api-secret",
  now: 1_000,
};

describe("Gmail MCP tickets", () => {
  it("round trips a short-lived operation-bound ticket", () => {
    const { ticket, expiresAt } = createGmailMcpTicket(input);

    expect(expiresAt).toBe(61_000);
    expect(verifyGmailMcpTicket({ ticket, secret: input.secret, now: input.now })).toMatchObject({
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
      registrationId: input.registrationId,
      operation: input.operation,
      expiresAt,
    });
  });

  it("rejects tampered, expired, cross-service, and malformed tickets", () => {
    const { ticket } = createGmailMcpTicket(input);
    const [payload, signature] = ticket.split(".");
    const calendarTicket = createGoogleCalendarMcpTicket({
      ...input,
      operation: { type: "tools/call", tool: "create_event", capability: "write" },
    }).ticket;

    expect(verifyGmailMcpTicket({ ticket: `${payload}x.${signature}`, secret: input.secret })).toBe(
      null,
    );
    expect(verifyGmailMcpTicket({ ticket, secret: input.secret, now: 61_000 })).toBe(null);
    expect(
      verifyGmailMcpTicket({ ticket: calendarTicket, secret: input.secret, now: input.now }),
    ).toBe(null);
    expect(
      verifyGmailMcpTicket({ ticket: "x".repeat(4_097), secret: input.secret, now: input.now }),
    ).toBe(null);
  });
});
