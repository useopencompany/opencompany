import type { GoatAnalyticsEventName, GoatAnalyticsEventProperties } from "./goat-events";
import { capturePostHogServerEvent } from "./server-core";

function getGoatPostHogConfig() {
  return {
    token: process.env.NEXT_PUBLIC_GOAT_POSTHOG_TOKEN,
    host: process.env.NEXT_PUBLIC_GOAT_POSTHOG_HOST,
    project: "goat" as const,
  };
}

export function captureGoatServerEvent<EventName extends GoatAnalyticsEventName>(
  event: EventName,
  distinctId: string,
  properties: GoatAnalyticsEventProperties<EventName>,
) {
  return capturePostHogServerEvent(getGoatPostHogConfig(), {
    event,
    distinctId,
    properties,
  });
}
