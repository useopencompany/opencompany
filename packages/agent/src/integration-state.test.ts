import { describe, expect, it } from "vitest";
import { integrationStateFromRows } from "./integration-state";
import {
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_MCP_RECONNECT_REASON,
  GOOGLE_CALENDAR_READ_SCOPE,
} from "./integrations/google-calendar-scopes";
import { SLACK_MCP_RECONNECT_REASON, SLACK_MCP_USER_SCOPES } from "./integrations/slack-scopes";

describe("Google Calendar integration state", () => {
  it("requires a legacy connection to grant the opencompany MCP scopes", () => {
    const state = integrationStateFromRows([
      {
        id: "gint_google_calendar",
        provider: "google_calendar",
        status: "connected",
        scopes: [GOOGLE_CALENDAR_READ_SCOPE],
      },
    ]);

    expect(state.personalAccounts.google_calendar[0]).toMatchObject({
      connected: false,
      status: "needs_reauth",
      statusReason: GOOGLE_CALENDAR_MCP_RECONNECT_REASON,
    });
  });

  it("accepts a complete opencompany Calendar MCP grant", () => {
    const state = integrationStateFromRows([
      {
        id: "gint_google_calendar",
        provider: "google_calendar",
        status: "connected",
        scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE],
      },
    ]);

    expect(state.personalAccounts.google_calendar[0]).toMatchObject({
      connected: true,
      status: "connected",
      statusReason: null,
    });
  });
});

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
