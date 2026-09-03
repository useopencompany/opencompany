import { describe, expect, it } from "vitest";
import { integrationStateFromRows } from "./integration-state";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_READ_SCOPE,
} from "./integrations/google-drive-scopes";
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

describe("Google Drive integration state", () => {
  it("keeps legacy accounts connected for Brain ingestion without the plugin grant", () => {
    const state = integrationStateFromRows([
      {
        id: "gint_drive",
        provider: "google_drive",
        accountEmail: "ada@example.com",
        status: "connected",
        scopes: [GOOGLE_DRIVE_READ_SCOPE],
      },
    ]);

    expect(state.google_drive).toMatchObject({
      integrationId: "gint_drive",
      connected: true,
      status: "connected",
    });
    expect(state.personalAccounts.google_drive[0]).toMatchObject({
      integrationId: "gint_drive",
      connected: true,
      status: "connected",
    });
  });

  it("accepts the complete official Google Drive MCP grant", () => {
    const state = integrationStateFromRows([
      {
        id: "gint_drive",
        provider: "google_drive",
        status: "connected",
        scopes: [GOOGLE_DRIVE_READ_SCOPE, GOOGLE_DRIVE_FILE_SCOPE],
      },
    ]);

    expect(state.personalAccounts.google_drive[0]).toMatchObject({
      connected: true,
      status: "connected",
    });
  });
});
