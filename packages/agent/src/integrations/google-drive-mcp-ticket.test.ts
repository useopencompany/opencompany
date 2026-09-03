import { describe, expect, it } from "vitest";
import { createGoogleDriveMcpTicket, verifyGoogleDriveMcpTicket } from "./google-drive-mcp-ticket";

const SECRET = "shared-test-secret";

describe("Google Drive MCP tickets", () => {
  it("round-trips a narrow tool-call grant", () => {
    const { ticket } = createGoogleDriveMcpTicket({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "integration_1",
      registrationId: "registration_1",
      operation: { type: "tools/call", tool: "search_files", capability: "read" },
      secret: SECRET,
      now: 1_000,
    });

    expect(verifyGoogleDriveMcpTicket({ ticket, secret: SECRET, now: 2_000 })).toMatchObject({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "integration_1",
      registrationId: "registration_1",
      operation: { type: "tools/call", tool: "search_files", capability: "read" },
    });
  });

  it("rejects expired and tampered tickets", () => {
    const { ticket } = createGoogleDriveMcpTicket({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "integration_1",
      registrationId: "registration_1",
      operation: { type: "tools/list" },
      secret: SECRET,
      now: 1_000,
      ttlMs: 10,
    });

    expect(verifyGoogleDriveMcpTicket({ ticket, secret: SECRET, now: 1_011 })).toBeNull();
    expect(
      verifyGoogleDriveMcpTicket({ ticket: `${ticket.slice(0, -1)}x`, secret: SECRET, now: 1_005 }),
    ).toBeNull();
  });
});
