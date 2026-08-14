// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  capture: vi.fn(),
  init: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

describe("marketing analytics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("captures page traffic and only explicit conversion events", async () => {
    vi.stubEnv("NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN", "phc_goat_test");
    vi.stubEnv("NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST", "https://eu.i.posthog.com");
    const { captureMarketingEvent, initMarketingAnalytics } = await import("./marketing-client");

    initMarketingAnalytics();
    captureMarketingEvent("marketing_clicked_signup", {});
    captureMarketingEvent("marketing_clicked_demo", {});

    expect(posthog.init).toHaveBeenCalledOnce();
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_goat_test",
      expect.objectContaining({
        api_host: "https://eu.i.posthog.com",
        advanced_disable_flags: true,
        autocapture: false,
        capture_dead_clicks: false,
        capture_exceptions: false,
        capture_heatmaps: false,
        capture_pageleave: true,
        capture_pageview: "history_change",
        capture_performance: false,
        disable_session_recording: true,
        disable_surveys: true,
        person_profiles: "identified_only",
        rageclick: false,
        respect_dnt: true,
        save_campaign_params: true,
        save_referrer: true,
      }),
    );
    expect(posthog.capture).toHaveBeenNthCalledWith(1, "marketing_clicked_signup", {});
    expect(posthog.capture).toHaveBeenNthCalledWith(2, "marketing_clicked_demo", {});
  });

  it("is a no-op without PostHog configuration", async () => {
    const { captureMarketingEvent, initMarketingAnalytics } = await import("./marketing-client");

    initMarketingAnalytics();
    captureMarketingEvent("marketing_clicked_demo", {});

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
