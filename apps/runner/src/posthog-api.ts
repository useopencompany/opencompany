import {
  type PostHogEventsCredentialPayload,
  posthogProjectApiUrl,
} from "@opencompany/agent/integrations/posthog-events";

export class PostHogAuthError extends Error {}

export type PostHogAnalyticsEvent = {
  uuid: string;
  event: string;
  distinctId: string;
  timestamp: string;
  createdAt: string;
  properties: Record<string, unknown>;
};

export async function queryPostHogEvents(input: {
  credential: PostHogEventsCredentialPayload;
  eventNames: readonly string[];
  cursorAt: string;
  cursorUuid: string;
  upperBound: string;
  limit: number;
  signal: AbortSignal;
}): Promise<PostHogAnalyticsEvent[]> {
  if (input.eventNames.length === 0) return [];
  const values: Record<string, unknown> = {
    cursorAt: input.cursorAt,
    cursorUuid: input.cursorUuid,
    upperBound: input.upperBound,
    eventNames: [...input.eventNames],
  };
  const query = `
    SELECT
      toString(uuid) AS uuid,
      event,
      distinct_id,
      timestamp,
      created_at,
      properties
    FROM events
    WHERE (
      created_at > toDateTime64({cursorAt}, 6, 'UTC')
      OR (
        created_at = toDateTime64({cursorAt}, 6, 'UTC')
        AND toString(uuid) > {cursorUuid}
      )
    )
      AND created_at < toDateTime64({upperBound}, 6, 'UTC')
      AND event IN {eventNames}
    ORDER BY created_at ASC, toString(uuid) ASC
    LIMIT ${Math.max(1, Math.min(1_000, Math.floor(input.limit)))}
  `;
  const timeout = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await fetch(
      posthogProjectApiUrl(input.credential.region, input.credential.projectId, "/query/"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.credential.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query, values } }),
        signal: AbortSignal.any([input.signal, timeout]),
      },
    );
  } catch (error) {
    if (input.signal.aborted) throw error;
    throw new Error("Could not reach PostHog's query API.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new PostHogAuthError("PostHog rejected the saved personal API key.");
  }
  if (!response.ok) throw new Error(`PostHog query failed (${response.status}).`);
  const body = (await response.json()) as { results?: unknown };
  if (!Array.isArray(body.results)) throw new Error("PostHog returned an unreadable query result.");
  return body.results.flatMap(parsePostHogEventRow);
}

function parsePostHogEventRow(value: unknown): PostHogAnalyticsEvent[] {
  if (!Array.isArray(value) || value.length < 6) return [];
  const [uuid, event, distinctId, timestamp, createdAt, rawProperties] = value;
  if (
    typeof uuid !== "string" ||
    !uuid ||
    typeof event !== "string" ||
    !event ||
    typeof distinctId !== "string" ||
    typeof timestamp !== "string" ||
    typeof createdAt !== "string" ||
    Number.isNaN(new Date(createdAt).getTime())
  ) {
    return [];
  }
  let properties: Record<string, unknown> = {};
  if (rawProperties && typeof rawProperties === "object" && !Array.isArray(rawProperties)) {
    properties = rawProperties as Record<string, unknown>;
  } else if (typeof rawProperties === "string") {
    try {
      const parsed = JSON.parse(rawProperties) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        properties = parsed as Record<string, unknown>;
      }
    } catch {
      // The event is still deliverable without malformed properties.
    }
  }
  return [{ uuid, event, distinctId, timestamp, createdAt, properties }];
}
