import { describe, expect, it } from "vitest";
import { effectiveCapabilityMode } from "../actions/capabilities";
import { integrationStateFromRows } from "../integration-state";
import { GOOGLE_ADMIN_SCOPES, googleAdminMcpScopesSatisfied } from "./google-admin-scopes";
import { GOOGLE_PROVIDER_CONFIG } from "./google-oauth";

describe("Google Admin consent and permissions", () => {
  it("requests only user/group scopes plus identity and requires both grants", () => {
    expect(GOOGLE_PROVIDER_CONFIG.google_admin.scopes).toEqual([
      ...GOOGLE_ADMIN_SCOPES,
      "openid",
      "email",
      "profile",
    ]);
    expect(googleAdminMcpScopesSatisfied(GOOGLE_ADMIN_SCOPES)).toBe(true);
    expect(googleAdminMcpScopesSatisfied([GOOGLE_ADMIN_SCOPES[0]!])).toBe(false);
    expect(
      googleAdminMcpScopesSatisfied([
        "https://www.googleapis.com/auth/admin.directory.user.readonly",
      ]),
    ).toBe(false);
    expect(effectiveCapabilityMode("google_admin", "query", {})).toBe("ask");
    expect(effectiveCapabilityMode("google_admin", "write", {})).toBe("ask");
    expect(effectiveCapabilityMode("google_admin", "write", { write: "off" })).toBe("off");
  });
  it("shows a partial grant as needing reconnection in the shared account view", () => {
    const state = integrationStateFromRows([
      { id: "admin", provider: "google_admin", status: "connected", scopes: [] },
    ]);
    expect(state.personalAccounts.google_admin).toMatchObject([
      { integrationId: "admin", connected: false, status: "needs_reauth" },
    ]);
  });
});
