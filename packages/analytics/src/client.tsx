"use client";

import { createLogger } from "@opencompany/observability";
import posthog from "posthog-js";
import { type ReactNode, useEffect } from "react";
import type { AnalyticsEventName, AnalyticsEventProperties } from "./events";

type AnalyticsIdentity = {
  userId: string;
  workspaceId: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
};

type AnalyticsProviderProps = {
  children: ReactNode;
  identity?: AnalyticsIdentity | null;
};

let initialized = false;
const logger = createLogger({ service: "opencompany-analytics", runtime: "browser" });

function isDebugEnabled() {
  return process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "true";
}

function getConfig() {
  return {
    token: process.env.NEXT_PUBLIC_POSTHOG_TOKEN,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  };
}

function debugLog(message: string, payload?: unknown) {
  if (!isDebugEnabled()) return;
  logger.info(`Analytics ${message}`, {
    event: "opencompany.analytics_debug",
    payload,
  });
}

function displayName(identity: AnalyticsIdentity) {
  return [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim();
}

function personProperties(identity: AnalyticsIdentity) {
  const name = displayName(identity);

  return {
    workspace_id: identity.workspaceId,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.firstName ? { first_name: identity.firstName } : {}),
    ...(identity.lastName ? { last_name: identity.lastName } : {}),
    ...(name ? { name } : {}),
  };
}

function debugIdentity(identity: AnalyticsIdentity) {
  return {
    userId: identity.userId,
    workspaceId: identity.workspaceId,
    hasEmail: Boolean(identity.email),
    hasFirstName: Boolean(identity.firstName),
    hasLastName: Boolean(identity.lastName),
  };
}

export function initClientAnalytics() {
  if (typeof window === "undefined" || initialized) return;

  const { token, host } = getConfig();
  if (!token || !host) {
    debugLog("client disabled: missing NEXT_PUBLIC_POSTHOG_TOKEN or NEXT_PUBLIC_POSTHOG_HOST");
    return;
  }

  try {
    posthog.init(token, {
      api_host: host,
      autocapture: false,
      capture_pageview: false,
      defaults: "2026-01-30",
      disable_session_recording: true,
    });
    initialized = true;
    debugLog("client initialized", { host });
  } catch (error) {
    debugLog("client init failed", error);
  }
}

export function identifyUser(identity: AnalyticsIdentity) {
  initClientAnalytics();
  debugLog("identify", debugIdentity(identity));

  if (!initialized) return;

  try {
    posthog.identify(identity.userId, personProperties(identity));
  } catch (error) {
    debugLog("identify failed", error);
  }
}

export function captureEvent<EventName extends AnalyticsEventName>(
  event: EventName,
  properties: AnalyticsEventProperties<EventName>,
) {
  initClientAnalytics();
  debugLog("capture", { event, properties });

  if (!initialized) return;

  try {
    posthog.capture(event, properties);
  } catch (error) {
    debugLog("capture failed", error);
  }
}

export function AnalyticsProvider({ children, identity }: AnalyticsProviderProps) {
  useEffect(() => {
    initClientAnalytics();
  }, []);

  useEffect(() => {
    if (!identity) return;
    identifyUser(identity);
  }, [identity]);

  return children;
}
