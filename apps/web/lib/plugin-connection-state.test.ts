import { integrationStateFromRows } from "@opencompany/agent/integration-state";
import { describe, expect, it } from "vitest";
import { pluginAccountsFromState } from "./plugin-connection-state";

const MAIL_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite"];

describe("plugin account selection", () => {
  it.each(["outlook", "outlook-calendar"] as const)(
    "uses the most recently connected %s account even when it needs reauthorization",
    (provider) => {
      const state = integrationStateFromRows([
        {
          id: "older",
          provider,
          status: "connected",
          scopes:
            provider === "outlook"
              ? ["offline_access", "User.Read", "Mail.ReadWrite"]
              : ["offline_access", "User.Read", "Calendars.ReadWrite"],
          lastSyncedAt: "2026-09-01T10:00:00.000Z",
        },
        {
          id: "newer",
          provider,
          status: "needs_reauth",
          scopes: [],
          lastSyncedAt: "2026-09-02T10:00:00.000Z",
        },
      ]);

      expect(pluginAccountsFromState(state, { connectionProvider: provider })).toMatchObject({
        permissionConnection: {
          integrationId: "newer",
          connected: false,
          status: "needs_reauth",
        },
      });
    },
  );

  // Live Electric rows arrive in no particular order, so selection has to come
  // from the connection timestamp rather than the account's position in the list.
  it.each([
    ["oldest first", ["older", "newer"]],
    ["newest first", ["newer", "older"]],
  ] as const)("selects the most recently connected account with rows %s", (_label, order) => {
    const rows = {
      older: {
        id: "older",
        provider: "outlook" as const,
        status: "connected" as const,
        scopes: MAIL_SCOPES,
        lastSyncedAt: "2026-09-01T10:00:00.000Z",
      },
      newer: {
        id: "newer",
        provider: "outlook" as const,
        status: "connected" as const,
        scopes: MAIL_SCOPES,
        lastSyncedAt: "2026-09-02T10:00:00.000Z",
      },
    };
    const state = integrationStateFromRows(order.map((key) => rows[key]));

    expect(
      pluginAccountsFromState(state, { connectionProvider: "outlook" }).permissionConnection,
    ).toMatchObject({ integrationId: "newer" });
  });

  it("keeps the same account selected after a permission edit on the older one", () => {
    // applyIntegrationCapabilityMode bumps updatedAt but leaves lastSyncedAt
    // alone, so editing permissions must not move tools onto another mailbox.
    const state = integrationStateFromRows([
      {
        id: "older",
        provider: "outlook",
        status: "connected",
        scopes: MAIL_SCOPES,
        lastSyncedAt: "2026-09-01T10:00:00.000Z",
        capabilityModes: { outlook_send_draft: "on" },
      },
      {
        id: "newer",
        provider: "outlook",
        status: "connected",
        scopes: MAIL_SCOPES,
        lastSyncedAt: "2026-09-02T10:00:00.000Z",
      },
    ]);

    expect(
      pluginAccountsFromState(state, { connectionProvider: "outlook" }).permissionConnection,
    ).toMatchObject({ integrationId: "newer" });
  });

  it("moves tools onto an older account after it is reconnected", () => {
    // Account A connected first and B second, then the user reconnected A. The
    // OAuth upsert refreshes lastSyncedAt without changing createdAt, so A is
    // active again even though B is still the more recently created row.
    const state = integrationStateFromRows([
      {
        id: "a",
        provider: "outlook",
        status: "connected",
        scopes: MAIL_SCOPES,
        lastSyncedAt: "2026-09-03T10:00:00.000Z",
      },
      {
        id: "b",
        provider: "outlook",
        status: "connected",
        scopes: MAIL_SCOPES,
        lastSyncedAt: "2026-09-02T10:00:00.000Z",
      },
    ]);

    expect(
      pluginAccountsFromState(state, { connectionProvider: "outlook" }).permissionConnection,
    ).toMatchObject({ integrationId: "a" });
  });
});
