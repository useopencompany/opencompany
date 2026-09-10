import { integrationStateFromRows } from "@opencompany/agent/integration-state";
import { describe, expect, it } from "vitest";
import { pluginAccountsFromState } from "./plugin-connection-state";

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
        },
        { id: "newer", provider, status: "needs_reauth", scopes: [] },
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
});
