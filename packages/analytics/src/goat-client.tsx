"use client";

import { createLogger } from "@opencompany/observability";
import posthog from "posthog-js";
import { type ReactNode, useEffect } from "react";
import type { GoatAnalyticsEventName, GoatAnalyticsEventProperties } from "./goat-events";

export type GoatAnalyticsIdentity = {
  userId: string;
  workspaceId: string;
};

type GoatAnalyticsProviderProps = {
  children: ReactNode;
  identity: GoatAnalyticsIdentity;
};

let initialized = false;
let capturedAppOpenKey: string | undefined;
const logger = createLogger({ service: "opencompany-analytics", runtime: "browser" });
const GOAT_PROPERTY_DENYLIST = [
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
];

function isDebugEnabled() {
  return process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "true";
}

function getConfig() {
  return {
    token: process.env.NEXT_PUBLIC_GOAT_POSTHOG_TOKEN,
    host: process.env.NEXT_PUBLIC_GOAT_POSTHOG_HOST,
  };
}

function debugLog(message: string, payload?: unknown) {
  if (!isDebugEnabled()) return;
  logger.info(`Goat analytics ${message}`, {
    event: "opencompany.analytics_debug",
    project: "goat",
    payload,
  });
}

export function initGoatClientAnalytics() {
  if (typeof window === "undefined" || initialized) return;

  const { token, host } = getConfig();
  if (!token || !host) {
    debugLog("client disabled: missing Goat PostHog token or host");
    return;
  }

  try {
    posthog.init(token, {
      api_host: host,
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
      person_profiles: "identified_only",
      persistence: "localStorage",
      property_denylist: GOAT_PROPERTY_DENYLIST,
      rageclick: false,
      respect_dnt: true,
      save_campaign_params: false,
      save_referrer: false,
    });
    initialized = true;
    debugLog("client initialized", { host });
  } catch (error) {
    debugLog("client init failed", error);
  }
}

export function captureGoatEvent<EventName extends GoatAnalyticsEventName>(
  event: EventName,
  properties: GoatAnalyticsEventProperties<EventName>,
) {
  initGoatClientAnalytics();
  debugLog("capture", { event, properties });

  if (!initialized) return false;

  try {
    posthog.capture(event, properties);
    return true;
  } catch (error) {
    debugLog("capture failed", error);
    return false;
  }
}

function identifyGoatUser(identity: GoatAnalyticsIdentity) {
  initGoatClientAnalytics();
  if (!initialized) return;

  try {
    const previousUserId = posthog.get_property("$user_id");
    if (typeof previousUserId === "string" && previousUserId !== identity.userId) {
      posthog.reset();
    }
    posthog.identify(identity.userId, { workspace_id: identity.workspaceId });
  } catch (error) {
    debugLog("identify failed", error);
  }
}

export function GoatAnalyticsProvider({ children, identity }: GoatAnalyticsProviderProps) {
  useEffect(() => {
    identifyGoatUser(identity);

    const appOpenKey = `${identity.userId}:${identity.workspaceId}`;
    if (capturedAppOpenKey === appOpenKey) return;

    const captured = captureGoatEvent("app_opened", { workspace_id: identity.workspaceId });
    if (captured) capturedAppOpenKey = appOpenKey;
  }, [identity.userId, identity.workspaceId]);

  return children;
}
