import { describe, expect, it } from "vitest";
import { integrationStateFromRows } from "./integration-state";
import { SLACK_MCP_RECONNECT_REASON, SLACK_MCP_USER_SCOPES } from "./integrations/slack-scopes";

describe("Slack integration state", () => {
  it("requires legacy ingestion grants to reconnect for the official plugin", () => {
    const state = integrationStateFromRows([
      {
        id: "gint_slack",
        provider: "slack",
        externalId: "T123",
        connectionLabel: "Acme",
        accountName: "Ada",
        status: "connected",
        scopes: ["channels:history", "channels:read", "search:read"],
      },
    ]);

    expect(state.slack).toMatchObject({
      connected: false,
      status: "needs_reauth",
      statusReason: SLACK_MCP_RECONNECT_REASON,
    });
    expect(state.personalAccounts.slack[0]).toMatchObject({
      connected: false,
      status: "needs_reauth",
      statusReason: SLACK_MCP_RECONNECT_REASON,
    });
  });

  it("accepts a complete official Slack MCP grant", () => {
    const state = integrationStateFromRows([
      {
        id: "gint_slack",
        provider: "slack",
        externalId: "T123",
        status: "connected",
        scopes: [...SLACK_MCP_USER_SCOPES],
      },
    ]);

    expect(state.slack).toMatchObject({ connected: true, status: "connected" });
    expect(state.personalAccounts.slack[0]).toMatchObject({
      connected: true,
      status: "connected",
    });
  });
});

describe("Google integration state", () => {
  it("carries the server-selected Gmail account and its permission snapshot", () => {
    const state = integrationStateFromRows([
      {
        id: "gint_gmail_old",
        provider: "gmail",
        status: "connected",
        accountEmail: "old@example.com",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        capabilityModes: { query: "off" },
      },
      {
        id: "gint_gmail_primary",
        provider: "gmail",
        status: "connected",
        accountEmail: "primary@example.com",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        capabilityModes: { query: "ask", draft: "ask", write: "ask" },
      },
    ]);

    expect(state.gmail).toMatchObject({
      integrationId: "gint_gmail_primary",
      accountEmail: "primary@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      capabilityModes: { query: "ask", draft: "ask", write: "ask" },
    });
  });
});
