"use client";

import posthog from "posthog-js";
import type {
  MarketingAnalyticsEventName,
  MarketingAnalyticsEventProperties,
} from "./marketing-events";

let initialized = false;

function isDebugEnabled() {
  return process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "true";
}

function debugWarn(message: string, error?: unknown) {
  if (!isDebugEnabled()) return;
  console.warn(`[marketing analytics] ${message}`, error);
}

export function initMarketingAnalytics() {
  if (typeof window === "undefined" || initialized) return;

  const token = process.env.NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN;
  const host = process.env.NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST;
  if (!token || !host) return;

  try {
    posthog.init(token, {
      api_host: host,
      defaults: "2026-01-30",
      advanced_disable_flags: true,
      autocapture: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      capture_heatmaps: false,
      capture_pageleave: true,
      capture_pageview: "history_change",
      capture_performance: false,
      disable_conversations: true,
      disable_external_dependency_loading: true,
      disable_product_tours: true,
      disable_session_recording: true,
      disable_surveys: true,
      person_profiles: "identified_only",
      rageclick: false,
      respect_dnt: true,
      save_campaign_params: true,
      save_referrer: true,
    });
    initialized = true;
  } catch (error) {
    debugWarn("initialization failed", error);
  }
}

export function captureMarketingEvent<EventName extends MarketingAnalyticsEventName>(
  event: EventName,
  properties: MarketingAnalyticsEventProperties<EventName>,
) {
  initMarketingAnalytics();
  if (!initialized) return;

  try {
    // Marketing CTAs navigate away immediately, so do not leave conversion events
    // waiting in PostHog's request batch for the page-unload flush.
    posthog.capture(event, properties, {
      send_instantly: true,
      transport: "sendBeacon",
    });
  } catch (error) {
    debugWarn(`capture failed for ${event}`, error);
  }
}
