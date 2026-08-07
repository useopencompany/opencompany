// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { captureGoatEvent, GoatAnalyticsProvider, identifyGoatUser } from "./goat-client";

const posthog = vi.hoisted(() => ({
  capture: vi.fn(),
  get_property: vi.fn(),
  identify: vi.fn(),
  init: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

vi.mock("@opencompany/observability", () => ({
  createLogger: () => ({ info: vi.fn() }),
}));

describe("GoatAnalyticsProvider", () => {
  it("captures one explicit app event with all automatic collection disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOAT_POSTHOG_TOKEN", "phc_goat_test");
    vi.stubEnv("NEXT_PUBLIC_GOAT_POSTHOG_HOST", "https://eu.i.posthog.com");

    const { rerender } = render(
      <GoatAnalyticsProvider
        identity={{
          userId: "user_123",
          workspaceId: "workspace_123",
          email: " ada@example.com ",
          firstName: " Ada ",
          lastName: " Lovelace ",
        }}
      >
        <div>Goat</div>
      </GoatAnalyticsProvider>,
    );

    await waitFor(() => expect(posthog.capture).toHaveBeenCalledOnce());

    expect(posthog.init).toHaveBeenCalledWith(
      "phc_goat_test",
      expect.objectContaining({
        api_host: "https://eu.i.posthog.com",
        advanced_disable_flags: true,
        autocapture: false,
        capture_dead_clicks: false,
        capture_exceptions: false,
        capture_heatmaps: false,
        capture_pageleave: false,
        capture_pageview: false,
        capture_performance: false,
        disable_conversations: true,
        disable_external_dependency_loading: true,
        disable_product_tours: true,
        disable_scroll_properties: true,
        disable_session_recording: true,
        disable_surveys: true,
        ip: false,
        persistence: "localStorage",
        property_denylist: [
          "$current_url",
          "$host",
          "$initial_current_url",
          "$initial_referrer",
          "$initial_referring_domain",
          "$pathname",
          "$referrer",
          "$referring_domain",
          "$session_id",
          "$window_id",
        ],
        rageclick: false,
        respect_dnt: true,
        save_campaign_params: false,
        save_referrer: false,
      }),
    );
    expect(posthog.identify).toHaveBeenCalledWith("user_123", {
      workspace_id: "workspace_123",
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      name: "Ada Lovelace",
    });
    expect(posthog.reset).not.toHaveBeenCalled();
    expect(posthog.capture).toHaveBeenCalledWith("app_opened", {
      workspace_id: "workspace_123",
    });

    rerender(
      <GoatAnalyticsProvider identity={{ userId: "user_123", workspaceId: "workspace_123" }}>
        <div>Goat</div>
      </GoatAnalyticsProvider>,
    );
    expect(posthog.capture).toHaveBeenCalledOnce();

    posthog.get_property.mockReturnValue("user_123");
    rerender(
      <GoatAnalyticsProvider identity={{ userId: "user_456", workspaceId: "workspace_456" }}>
        <div>Goat</div>
      </GoatAnalyticsProvider>,
    );

    await waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(2));
    expect(posthog.reset).toHaveBeenCalledOnce();
    expect(posthog.identify).toHaveBeenLastCalledWith("user_456", {
      workspace_id: "workspace_456",
    });

    vi.unstubAllEnvs();
  });

  it("identifies and captures onboarding events before a workspace exists", () => {
    vi.stubEnv("NEXT_PUBLIC_GOAT_POSTHOG_TOKEN", "phc_goat_test");
    vi.stubEnv("NEXT_PUBLIC_GOAT_POSTHOG_HOST", "https://eu.i.posthog.com");

    identifyGoatUser({ userId: "user_123", email: "ada@example.com" });
    captureGoatEvent("onboarding_step_viewed", {
      flow: "owner",
      step: "profile",
      step_index: 0,
      total_steps: 4,
    });

    expect(posthog.identify).toHaveBeenCalledWith("user_123", { email: "ada@example.com" });
    expect(posthog.capture).toHaveBeenCalledWith("onboarding_step_viewed", {
      flow: "owner",
      step: "profile",
      step_index: 0,
      total_steps: 4,
    });

    vi.unstubAllEnvs();
  });
});
