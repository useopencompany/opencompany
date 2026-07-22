import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  type GoatActionProviderCatalog,
  type ResolvedGoatAction,
  requiredStringParam,
  truncateText,
} from "@/lib/actions/types";
import { GoogleAccessAuthError, googleApiCall } from "@/lib/integrations/google-access-token";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const MAX_EVENTS = 25;
const MAX_QUERY_CHARS = 500;
const MAX_CALENDAR_ID_CHARS = 1_024;
const MAX_EVENT_SUMMARY_CHARS = 300;
const MAX_EVENT_DESCRIPTION_CHARS = 1_000;
const MAX_EVENT_LOCATION_CHARS = 500;
const MAX_EVENT_ATTENDEES = 20;

type GoogleCalendarConnection = {
  integrationId: string;
  accountEmail: string | null;
  accountName: string | null;
};

export async function resolveGoogleCalendarActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const connections = await loadGoogleCalendarConnections(userWorkosId);
  if (connections.length === 0) return null;

  const accountParam =
    connections.length > 1
      ? {
          account: {
            type: "string" as const,
            minLength: 1,
            maxLength: 400,
            description: `Which connected Google Calendar account to use. One of: ${connections
              .map((connection) => JSON.stringify(accountSelector(connection, connections)))
              .join(", ")}.`,
          },
        }
      : {};
  const required = ["time_min", "time_max"];
  if (connections.length > 1) required.push("account");

  const actions: ResolvedGoatAction[] = [
    {
      id: "google_calendar.list_events",
      provider: "google_calendar",
      description:
        "List events from a connected Google Calendar in a bounded time window, optionally filtering by text. Returns compact event details including times, location, attendees, and meeting links.",
      params: {
        type: "object",
        additionalProperties: false,
        required,
        properties: {
          calendar_id: {
            type: "string",
            minLength: 1,
            maxLength: MAX_CALENDAR_ID_CHARS,
            description: 'Calendar id. Defaults to "primary".',
          },
          time_min: {
            type: "string",
            format: "date-time",
            description: "Inclusive RFC 3339 lower bound, including Z or a numeric UTC offset.",
          },
          time_max: {
            type: "string",
            format: "date-time",
            description: "Exclusive RFC 3339 upper bound, including Z or a numeric UTC offset.",
          },
          query: {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUERY_CHARS,
            description: "Optional free-text search across event fields.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_EVENTS,
            description: "Maximum events to return (default 10, max 25).",
          },
          ...accountParam,
        },
      },
      execute: async (params, context) => {
        const hasMultipleAccounts = connections.length > 1;
        assertOnlyKnownParams(params, hasMultipleAccounts);
        const account = hasMultipleAccounts
          ? boundedOptionalString(params, "account", 400)
          : undefined;
        const connection = resolveConnection(connections, account);
        const { timeMin, timeMax } = validateTimeWindow(
          requiredStringParam(params, "time_min"),
          requiredStringParam(params, "time_max"),
        );
        const calendarId =
          boundedOptionalString(params, "calendar_id", MAX_CALENDAR_ID_CHARS) ?? "primary";
        const query = boundedOptionalString(params, "query", MAX_QUERY_CHARS);
        const limit = validateLimit(params.limit);
        const url = new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set("showDeleted", "false");
        url.searchParams.set("timeMin", timeMin);
        url.searchParams.set("timeMax", timeMax);
        url.searchParams.set("maxResults", String(limit));
        url.searchParams.set(
          "fields",
          "nextPageToken,timeZone,items(id,status,summary,description,location,htmlLink,hangoutLink,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self))",
        );
        if (query) url.searchParams.set("q", query);

        const response = asRecord(await calendarApiCall(context, connection, url));
        const rawEvents = asArray(response.items);
        return {
          account: connectionLabel(connection),
          calendarId,
          timeMin,
          timeMax,
          timeZone: readBoundedString(response.timeZone, 100),
          events: rawEvents.slice(0, limit).flatMap((event) => {
            const compact = compactEvent(asRecord(event));
            return compact ? [compact] : [];
          }),
          hasMore: rawEvents.length > limit || Boolean(readString(response.nextPageToken)),
        };
      },
    },
  ];

  return {
    id: "google_calendar",
    label:
      connections.length === 1
        ? `Google Calendar (${connectionLabel(connections[0]!)})`
        : `Google Calendar (${connections.length} accounts)`,
    description: "List calendar events in a bounded time window.",
    actions,
  };
}

async function loadGoogleCalendarConnections(
  userWorkosId: string,
): Promise<GoogleCalendarConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      accountEmail: goatIntegrations.accountEmail,
      accountName: goatIntegrations.accountName,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "google_calendar"),
        ne(goatIntegrations.status, "disconnected"),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt));

  return rows
    .filter((row) => row.status === "connected")
    .map((row) => ({
      integrationId: row.integrationId,
      accountEmail: row.accountEmail,
      accountName: row.accountName,
    }));
}

function resolveConnection(
  connections: readonly GoogleCalendarConnection[],
  account: string | undefined,
): GoogleCalendarConnection {
  if (account) {
    const wanted = normalizeAccountSelector(account);
    const match = connections.find(
      (connection) => normalizeAccountSelector(accountSelector(connection, connections)) === wanted,
    );
    if (match) return match;
    throw new GoatActionInvalidParamsError(
      `No connected Google Calendar account matches ${JSON.stringify(account)}. Connected accounts: ${connections
        .map((connection) => JSON.stringify(accountSelector(connection, connections)))
        .join(", ")}.`,
    );
  }
  if (connections.length === 1) return connections[0]!;
  throw new GoatActionInvalidParamsError(
    `Multiple Google Calendar accounts are connected; pass account as one of: ${connections
      .map((connection) => JSON.stringify(accountSelector(connection, connections)))
      .join(", ")}.`,
  );
}

async function calendarApiCall(
  context: GoatActionExecuteContext,
  connection: GoogleCalendarConnection,
  url: URL,
) {
  try {
    return await googleApiCall(
      {
        userWorkosId: context.userWorkosId,
        integrationId: connection.integrationId,
        provider: "google_calendar",
      },
      "GET",
      url,
      { signal: context.signal },
    );
  } catch (error) {
    if (error instanceof GoogleAccessAuthError) {
      throw new GoatActionAuthError(
        "auth_expired",
        "google_calendar",
        `Reconnect Google Calendar for ${connectionLabel(connection)} in Settings → Integrations using “Reconnect or add”, select the same Google account, then retry.`,
      );
    }
    throw error;
  }
}

function validateTimeWindow(timeMin: string, timeMax: string) {
  const normalizedMin = validateRfc3339(timeMin, "time_min");
  const normalizedMax = validateRfc3339(timeMax, "time_max");
  if (Date.parse(normalizedMax) <= Date.parse(normalizedMin)) {
    throw new GoatActionInvalidParamsError('"time_max" must be after "time_min".');
  }
  return { timeMin: normalizedMin, timeMax: normalizedMax };
}

function validateRfc3339(value: string, field: string) {
  const trimmed = value.trim();
  const date = new Date(`${trimmed.slice(0, 10)}T00:00:00Z`);
  if (
    trimmed.length > 100 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== trimmed.slice(0, 10) ||
    Number.isNaN(Date.parse(trimmed))
  ) {
    throw new GoatActionInvalidParamsError(
      `"${field}" must be an RFC 3339 date-time with Z or a numeric UTC offset.`,
    );
  }
  return trimmed;
}

function validateLimit(value: unknown) {
  if (value === undefined) return 10;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_EVENTS) {
    throw new GoatActionInvalidParamsError(`"limit" must be an integer from 1 to ${MAX_EVENTS}.`);
  }
  return value;
}

function assertOnlyKnownParams(params: Record<string, unknown>, allowAccount: boolean) {
  const unknown = Object.keys(params).filter(
    (key) =>
      key !== "calendar_id" &&
      key !== "time_min" &&
      key !== "time_max" &&
      key !== "query" &&
      key !== "limit" &&
      !(allowAccount && key === "account"),
  );
  if (unknown.length > 0) {
    throw new GoatActionInvalidParamsError(
      `Unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown
        .map((key) => JSON.stringify(key))
        .join(", ")}.`,
    );
  }
}

function boundedOptionalString(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new GoatActionInvalidParamsError(`"${key}" must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" exceeds ${maxChars} characters.`);
  }
  return trimmed;
}

function compactEvent(event: Record<string, unknown>) {
  const id = readBoundedString(event.id, 1_024);
  const start = compactEventTime(asRecord(event.start));
  const end = compactEventTime(asRecord(event.end));
  if (!id || (!start.date && !start.dateTime) || (!end.date && !end.dateTime)) return null;
  const htmlLink = readGoogleUrl(event.htmlLink);
  const hangoutLink = readGoogleUrl(event.hangoutLink);
  const organizer = compactPerson(asRecord(event.organizer));
  return {
    id,
    status: readBoundedString(event.status, 50),
    summary: truncateText(readString(event.summary), MAX_EVENT_SUMMARY_CHARS),
    description: truncateText(readString(event.description), MAX_EVENT_DESCRIPTION_CHARS),
    location: truncateText(readString(event.location), MAX_EVENT_LOCATION_CHARS),
    ...(htmlLink ? { htmlLink } : {}),
    ...(hangoutLink ? { hangoutLink } : {}),
    start,
    end,
    ...(organizer ? { organizer } : {}),
    attendees: asArray(event.attendees)
      .slice(0, MAX_EVENT_ATTENDEES)
      .flatMap((attendee) => {
        const person = compactPerson(asRecord(attendee));
        return person ? [person] : [];
      }),
  };
}

function compactEventTime(value: Record<string, unknown>) {
  return {
    date: readBoundedString(value.date, 10),
    dateTime: readBoundedString(value.dateTime, 100),
    timeZone: readBoundedString(value.timeZone, 100),
  };
}

function compactPerson(value: Record<string, unknown>) {
  const email = readBoundedString(value.email, 320);
  const displayName = truncateText(readString(value.displayName), 200);
  if (!email && !displayName) return null;
  return {
    email,
    displayName,
    responseStatus: readBoundedString(value.responseStatus, 50),
    self: value.self === true || undefined,
  };
}

function connectionLabel(connection: GoogleCalendarConnection) {
  const label = connection.accountEmail?.trim() || connection.accountName?.trim();
  if (!label) return "Google account";
  const normalized = label.replace(/\s+/g, " ");
  return normalized.length > 100 ? `${normalized.slice(0, 100)}…` : normalized;
}

function accountSelector(
  connection: GoogleCalendarConnection,
  connections: readonly GoogleCalendarConnection[],
) {
  const label = connectionLabel(connection);
  const duplicateLabel = connections.some(
    (entry) =>
      entry !== connection &&
      normalizeAccountSelector(connectionLabel(entry)) === normalizeAccountSelector(label),
  );
  return duplicateLabel ? `${label} (${connection.integrationId})` : label;
}

function normalizeAccountSelector(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function readBoundedString(value: unknown, maxChars: number) {
  const string = readString(value);
  return string && string.length <= maxChars ? string : undefined;
}

function readGoogleUrl(value: unknown) {
  const candidate = readBoundedString(value, 2_048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "google.com" && !url.hostname.endsWith(".google.com"))
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
