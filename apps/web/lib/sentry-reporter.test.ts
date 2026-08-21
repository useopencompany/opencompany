import { describe, expect, it } from "vitest";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "./sentry-reporter";

describe("scrubSentryEvent", () => {
  it("removes request secrets and anonymous user details while preserving routing context", () => {
    const event = {
      type: undefined,
      request: {
        url: "https://my.opencompany.chat/app?token=secret",
        method: "GET",
        env: { runtime: "node" },
        headers: { authorization: "Bearer secret", cookie: "session=secret" },
        cookies: { session: "secret" },
        data: "secret body",
        query_string: "token=secret",
      },
      user: {
        ip_address: "192.0.2.1",
        email: "person@example.com",
      },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.request).toEqual({
      url: "https://my.opencompany.chat/app",
      method: "GET",
    });
    expect(scrubbed.user).toEqual({ ip_address: "0.0.0.0" });
  });

  it("keeps an explicit internal user id but removes all other user fields", () => {
    const event = {
      type: undefined,
      user: {
        id: "user_123",
        email: "person@example.com",
        ip_address: "192.0.2.1",
      },
    };

    expect(scrubSentryEvent(event).user).toEqual({ id: "user_123", ip_address: "0.0.0.0" });
  });

  it("explicitly disables transport IP inference when an event has no user", () => {
    expect(scrubSentryEvent({ type: undefined }).user).toEqual({ ip_address: "0.0.0.0" });
  });

  it("drops console breadcrumbs that could contain application secrets", () => {
    expect(scrubSentryBreadcrumb({ category: "console", message: "Bearer secret" })).toBeNull();
    expect(scrubSentryBreadcrumb({ category: "navigation", message: "/app" })).toEqual({
      category: "navigation",
      message: "/app",
    });
  });
});
