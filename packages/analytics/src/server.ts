import type { AnalyticsEventName, AnalyticsEventProperties } from "./events";
import { capturePostHogServerEvent } from "./server-core";

function getConfig() {
  return {
    token: process.env.NEXT_PUBLIC_POSTHOG_TOKEN,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    project: "web" as const,
  };
}

export function captureServerEvent<EventName extends AnalyticsEventName>(
  event: EventName,
  distinctId: string,
  properties: AnalyticsEventProperties<EventName>,
) {
  return capturePostHogServerEvent(getConfig(), {
    event,
    distinctId,
    properties,
  });
}
