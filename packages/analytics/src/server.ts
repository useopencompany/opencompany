import { createLogger } from "@opencompany/observability";
import { PostHog } from "posthog-node";
import type { AnalyticsEventName, AnalyticsEventProperties } from "./events";

const SERVER_CAPTURE_TIMEOUT_MS = 1500;
const logger = createLogger({ service: "opencompany-analytics", runtime: "server" });

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

export async function captureServerEvent<EventName extends AnalyticsEventName>(
  event: EventName,
  distinctId: string,
  properties: AnalyticsEventProperties<EventName>,
) {
  debugLog("server capture", { event, distinctId, properties });

  const { token, host } = getConfig();
  if (!token || !host) {
    debugLog("server disabled: missing NEXT_PUBLIC_POSTHOG_TOKEN or NEXT_PUBLIC_POSTHOG_HOST");
    return;
  }

  let client: PostHog | undefined;

  try {
    client = new PostHog(token, {
      host,
      flushAt: 1,
      flushInterval: 0,
      requestTimeout: SERVER_CAPTURE_TIMEOUT_MS,
    });

    client.capture({
      distinctId,
      event,
      properties,
    });
  } catch (error) {
    debugLog("server capture failed", error);
  } finally {
    try {
      await client?.shutdown(SERVER_CAPTURE_TIMEOUT_MS);
    } catch (error) {
      debugLog("server shutdown failed", error);
    }
  }
}
