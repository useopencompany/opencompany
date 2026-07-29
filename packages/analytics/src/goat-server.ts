import type { GoatAnalyticsEventName, GoatAnalyticsEventProperties } from "./goat-events";
import { type GoatAnalyticsPerson, goatAnalyticsPersonProperties } from "./goat-person";
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
  person?: GoatAnalyticsPerson,
) {
  const personProperties = person ? goatAnalyticsPersonProperties(person) : undefined;

  return capturePostHogServerEvent(getGoatPostHogConfig(), {
    event,
    distinctId,
    properties: {
      ...properties,
      ...(personProperties && Object.keys(personProperties).length > 0
        ? { $set: personProperties }
        : {}),
    },
  });
}
