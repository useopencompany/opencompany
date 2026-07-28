import { createLogger } from "@opencompany/observability";
import { PostHog } from "posthog-node";

const SERVER_CAPTURE_TIMEOUT_MS = 1500;
const logger = createLogger({ service: "opencompany-analytics", runtime: "server" });

type PostHogServerEvent = {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
};

type PostHogServerConfig = {
  host: string | undefined;
  project: "goat" | "web";
  token: string | undefined;
};

function isDebugEnabled() {
  return process.env.NEXT_PUBLIC_ANALYTICS_DEBUG === "true";
}

function debugLog(project: PostHogServerConfig["project"], message: string, payload?: unknown) {
  if (!isDebugEnabled()) return;
  logger.info(`Analytics ${message}`, {
    event: "opencompany.analytics_debug",
    project,
    payload,
  });
}

export async function capturePostHogServerEvent(
  config: PostHogServerConfig,
  event: PostHogServerEvent,
) {
  debugLog(config.project, "server capture", event);

  if (!config.token || !config.host) {
    debugLog(config.project, "server disabled: missing PostHog token or host");
    return;
  }

  let client: PostHog | undefined;

  try {
    client = new PostHog(config.token, {
      host: config.host,
      flushAt: 1,
      flushInterval: 0,
      requestTimeout: SERVER_CAPTURE_TIMEOUT_MS,
    });
    client.capture(event);
  } catch (error) {
    debugLog(config.project, "server capture failed", error);
  } finally {
    try {
      await client?.shutdown(SERVER_CAPTURE_TIMEOUT_MS);
    } catch (error) {
      debugLog(config.project, "server shutdown failed", error);
    }
  }
}
