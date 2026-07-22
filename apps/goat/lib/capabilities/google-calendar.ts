import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  refreshGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { jsonSchema, type ToolSet, tool } from "ai";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  GoatCapabilityAuthError,
  type GoatCapabilityDefinition,
  type GoatCapabilityOperation,
  type GoatCapabilityWorkerContext,
} from "@/lib/capabilities/types";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REFRESH_SKEW_MS = 60_000;
const MAX_CALENDARS = 100;
const MAX_EVENTS = 50;
const MAX_EVENT_TEXT_CHARS = 4_000;
const MAX_EVENT_DESCRIPTION_RESULT_CHARS = 1_000;
const CALENDAR_EVENTS_WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_WRITE_SCOPE = "https://www.googleapis.com/auth/calendar";

type CalendarConnection = {
  integrationId: string;
  accountEmail: string | null;
  accountName: string | null;
  scopes: string[];
};

type StoredGoogleTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

type CalendarRequestContext = {
  userWorkosId: string;
  signal: AbortSignal;
  connections: readonly CalendarConnection[];
};

type CalendarAccountInput = { account?: string };

type CalendarEventTimeInput = {
  start: string;
  end: string;
  allDay?: boolean;
  timeZone?: string;
};

type CalendarCreateEventInput = CalendarAccountInput &
  CalendarEventTimeInput & {
    calendarId?: string;
    summary: string;
    description?: string;
    location?: string;
  };

type CalendarUpdateEventInput = CalendarAccountInput & {
  calendarId?: string;
  eventId: string;
  summary?: string;
  description?: string | null;
  location?: string | null;
  start?: string;
  end?: string;
  allDay?: boolean;
  timeZone?: string;
};

export const googleCalendarCapability: GoatCapabilityDefinition = {
  id: "google_calendar",
  workerModel: "openai/gpt-5.4-mini",
  async resolve(userWorkosId) {
    const connections = await loadCalendarConnections(userWorkosId);
    if (connections.length === 0) return null;

    const canWrite = connections.some(hasCalendarWriteScope);
    const accountLabel = formatAccountLabel(connections);
    return {
      operations: canWrite ? ["read", "create", "write"] : ["read"],
      indexLine:
        `google_calendar — accesses the user's Google Calendar${accountLabel}. ` +
        "CAN list calendars, events, event details, and free/busy windows. " +
        (canWrite
          ? "CAN create events and update or delete an event when explicitly requested. "
          : "CANNOT change events until Google Calendar is reconnected with edit access. ") +
        "CANNOT add attendees, send invitations, respond to invitations, or change calendar settings.",
      recipeLines: [
        ...(connections.length > 1
          ? [
              `Multiple accounts are connected (${connections
                .map((connection) => JSON.stringify(connectionLabel(connection)))
                .join(
                  ", ",
                )}). Pass the exact account email to every tool; do not choose an account without the user's direction.`,
            ]
          : []),
        "Use calendar_list_events with a bounded timeMin/timeMax window to find candidate events. Use calendar_get_event to confirm the exact event id and current details before updating or deleting it.",
        "Treat an all-day event's end date as exclusive. For timed events, include an RFC 3339 offset or pass the user's IANA time zone.",
        "Create, update, or delete only the one event explicitly requested in this worker call. Do not infer attendees or send invitations; attendee changes are unsupported.",
        "Never retry a calendar mutation after an error or ambiguous response. Report the account, calendar id, event id, and resulting time for a completed change.",
        'Cite events as type "google_calendar_event", using the entity id and url returned by the tools.',
      ],
      createTools: (context, operation) => createCalendarTools(context, connections, operation),
    };
  },
};

async function loadCalendarConnections(userWorkosId: string): Promise<CalendarConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      accountEmail: goatIntegrations.accountEmail,
      accountName: goatIntegrations.accountName,
      scopes: goatIntegrations.scopes,
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
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
    }));
}

export function hasCalendarWriteScope(connection: Pick<CalendarConnection, "scopes">) {
  return (
    connection.scopes.includes(CALENDAR_EVENTS_WRITE_SCOPE) ||
    connection.scopes.includes(CALENDAR_WRITE_SCOPE)
  );
}

async function createCalendarTools(
  context: GoatCapabilityWorkerContext,
  connections: readonly CalendarConnection[],
  operation: GoatCapabilityOperation,
) {
  const requestContext: CalendarRequestContext = {
    userWorkosId: context.userWorkosId,
    signal: context.signal,
    connections,
  };
  const tools = createCalendarReadTools(requestContext);
  const mutationGuard = createMutationGuard();
  if (operation === "create") {
    tools.calendar_create_event = createEventTool(requestContext, mutationGuard);
  } else if (operation === "write") {
    tools.calendar_update_event = updateEventTool(requestContext, mutationGuard);
    tools.calendar_delete_event = deleteEventTool(requestContext, mutationGuard);
  }
  return { tools };
}

function createCalendarReadTools(context: CalendarRequestContext): ToolSet {
  return {
    calendar_list_calendars: tool({
      description:
        "List calendars available to one connected Google Calendar account, including access role and time zone.",
      inputSchema: accountInputSchema(),
      execute: async (args: CalendarAccountInput) => {
        const connection = resolveConnection(context.connections, args.account, false);
        const url = new URL(`${CALENDAR_BASE}/users/me/calendarList`);
        url.searchParams.set("maxResults", String(MAX_CALENDARS));
        url.searchParams.set("showHidden", "false");
        url.searchParams.set(
          "fields",
          "items(id,summary,description,primary,accessRole,timeZone,selected)",
        );
        const result = asRecord(await calendarApiCall(context, connection, "GET", url));
        return {
          account: connectionLabel(connection),
          calendars: asArray(result.items).map((value) => compactCalendar(asRecord(value))),
        };
      },
    }),
    calendar_list_events: tool({
      description:
        "List events on one calendar in a bounded RFC 3339 time window. Returns compact event entities.",
      inputSchema: jsonSchema<
        CalendarAccountInput & {
          calendarId?: string;
          timeMin: string;
          timeMax: string;
          query?: string;
          maxResults?: number;
        }
      >({
        type: "object",
        additionalProperties: false,
        properties: {
          account: accountProperty(),
          calendarId: calendarIdProperty(),
          timeMin: { type: "string", description: "Inclusive RFC 3339 lower bound." },
          timeMax: { type: "string", description: "Exclusive RFC 3339 upper bound." },
          query: { type: "string", minLength: 1, maxLength: 500 },
          maxResults: { type: "number", minimum: 1, maximum: MAX_EVENTS },
        },
        required: ["timeMin", "timeMax"],
      }),
      execute: async (args) => {
        const { timeMin, timeMax } = validateTimeWindow(args.timeMin, args.timeMax);
        const connection = resolveConnection(context.connections, args.account, false);
        const calendarId = optionalTrimmed(args.calendarId, "calendarId", 1_024) ?? "primary";
        const url = calendarEventsUrl(calendarId);
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set("timeMin", timeMin);
        url.searchParams.set("timeMax", timeMax);
        url.searchParams.set("maxResults", String(clampCount(args.maxResults, 20, MAX_EVENTS)));
        url.searchParams.set(
          "fields",
          "items(id,status,summary,description,location,htmlLink,start,end,organizer,attendees(email,displayName,responseStatus))",
        );
        const query = optionalTrimmed(args.query, "query", 500);
        if (query) url.searchParams.set("q", query);
        const result = asRecord(await calendarApiCall(context, connection, "GET", url));
        return {
          account: connectionLabel(connection),
          calendarId,
          events: asArray(result.items).map((value) =>
            compactEvent(asRecord(value), connection, calendarId),
          ),
        };
      },
    }),
    calendar_get_event: tool({
      description: "Get one exact Google Calendar event by calendar id and event id.",
      inputSchema: jsonSchema<CalendarAccountInput & { calendarId?: string; eventId: string }>({
        type: "object",
        additionalProperties: false,
        properties: {
          account: accountProperty(),
          calendarId: calendarIdProperty(),
          eventId: { type: "string", minLength: 1, maxLength: 1_024 },
        },
        required: ["eventId"],
      }),
      execute: async (args) => {
        const connection = resolveConnection(context.connections, args.account, false);
        const calendarId = optionalTrimmed(args.calendarId, "calendarId", 1_024) ?? "primary";
        const eventId = requiredTrimmed(args.eventId, "eventId", 1_024);
        const url = calendarEventUrl(calendarId, eventId);
        const result = asRecord(await calendarApiCall(context, connection, "GET", url));
        return {
          account: connectionLabel(connection),
          calendarId,
          event: compactEvent(result, connection, calendarId),
        };
      },
    }),
    calendar_get_freebusy: tool({
      description: "Read busy windows for one or more calendars over a bounded time range.",
      inputSchema: jsonSchema<
        CalendarAccountInput & { timeMin: string; timeMax: string; calendarIds?: string[] }
      >({
        type: "object",
        additionalProperties: false,
        properties: {
          account: accountProperty(),
          timeMin: { type: "string", description: "Inclusive RFC 3339 lower bound." },
          timeMax: { type: "string", description: "Exclusive RFC 3339 upper bound." },
          calendarIds: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 1_024 },
            maxItems: 20,
          },
        },
        required: ["timeMin", "timeMax"],
      }),
      execute: async (args) => {
        const { timeMin, timeMax } = validateTimeWindow(args.timeMin, args.timeMax);
        const connection = resolveConnection(context.connections, args.account, false);
        const calendarIds = (args.calendarIds?.length ? args.calendarIds : ["primary"]).map((id) =>
          requiredTrimmed(id, "calendarId", 1_024),
        );
        const result = asRecord(
          await calendarApiCall(context, connection, "POST", new URL(`${CALENDAR_BASE}/freeBusy`), {
            timeMin,
            timeMax,
            items: calendarIds.map((id) => ({ id })),
          }),
        );
        return {
          account: connectionLabel(connection),
          timeMin,
          timeMax,
          calendars: asRecord(result.calendars),
        };
      },
    }),
  };
}

function createEventTool(
  context: CalendarRequestContext,
  mutationGuard: ReturnType<typeof createMutationGuard>,
) {
  return tool({
    description:
      "Create one event without attendees or invitations. Use only for the user's explicit creation request. For all-day events, end is an exclusive YYYY-MM-DD date.",
    inputSchema: jsonSchema<CalendarCreateEventInput>({
      type: "object",
      additionalProperties: false,
      properties: {
        account: accountProperty(),
        calendarId: calendarIdProperty(),
        summary: { type: "string", minLength: 1, maxLength: 500 },
        description: { type: "string", maxLength: MAX_EVENT_TEXT_CHARS },
        location: { type: "string", maxLength: 1_000 },
        start: eventStartProperty(),
        end: eventEndProperty(),
        allDay: { type: "boolean" },
        timeZone: timeZoneProperty(),
      },
      required: ["summary", "start", "end"],
    }),
    execute: async (args) =>
      mutationGuard.run("calendar_create_event", async () => {
        const connection = resolveConnection(context.connections, args.account, true);
        const calendarId = optionalTrimmed(args.calendarId, "calendarId", 1_024) ?? "primary";
        const body = {
          summary: requiredTrimmed(args.summary, "summary", 500),
          ...(optionalTrimmed(args.description, "description", MAX_EVENT_TEXT_CHARS) !== undefined
            ? {
                description: optionalTrimmed(args.description, "description", MAX_EVENT_TEXT_CHARS),
              }
            : {}),
          ...(optionalTrimmed(args.location, "location", 1_000) !== undefined
            ? { location: optionalTrimmed(args.location, "location", 1_000) }
            : {}),
          ...eventTimeBody(args),
        };
        const url = calendarEventsUrl(calendarId);
        url.searchParams.set("sendUpdates", "none");
        const result = asRecord(await calendarApiCall(context, connection, "POST", url, body));
        return {
          account: connectionLabel(connection),
          calendarId,
          event: compactEvent(result, connection, calendarId),
        };
      }),
  });
}

function updateEventTool(
  context: CalendarRequestContext,
  mutationGuard: ReturnType<typeof createMutationGuard>,
) {
  return tool({
    description:
      "Update one confirmed event's title, description, location, or complete start/end pair. Null clears description or location. Does not change attendees or send notifications.",
    inputSchema: jsonSchema<CalendarUpdateEventInput>({
      type: "object",
      additionalProperties: false,
      properties: {
        account: accountProperty(),
        calendarId: calendarIdProperty(),
        eventId: { type: "string", minLength: 1, maxLength: 1_024 },
        summary: { type: "string", minLength: 1, maxLength: 500 },
        description: { type: ["string", "null"], maxLength: MAX_EVENT_TEXT_CHARS },
        location: { type: ["string", "null"], maxLength: 1_000 },
        start: eventStartProperty(),
        end: eventEndProperty(),
        allDay: { type: "boolean" },
        timeZone: timeZoneProperty(),
      },
      required: ["eventId"],
    }),
    execute: async (args) =>
      mutationGuard.run("calendar_update_event", async () => {
        const connection = resolveConnection(context.connections, args.account, true);
        const calendarId = optionalTrimmed(args.calendarId, "calendarId", 1_024) ?? "primary";
        const eventId = requiredTrimmed(args.eventId, "eventId", 1_024);
        const body: Record<string, unknown> = {};
        if (args.summary !== undefined)
          body.summary = requiredTrimmed(args.summary, "summary", 500);
        if (args.description === null) body.description = null;
        else if (args.description !== undefined) {
          body.description = optionalTrimmed(args.description, "description", MAX_EVENT_TEXT_CHARS);
        }
        if (args.location === null) body.location = null;
        else if (args.location !== undefined) {
          body.location = optionalTrimmed(args.location, "location", 1_000);
        }
        const hasAnyTime =
          args.start !== undefined ||
          args.end !== undefined ||
          args.allDay !== undefined ||
          args.timeZone !== undefined;
        if (hasAnyTime) {
          if (args.start === undefined || args.end === undefined) {
            throw new Error("Updating event time requires both start and end.");
          }
          Object.assign(body, eventTimeBody(args as CalendarEventTimeInput));
        }
        if (Object.keys(body).length === 0) {
          throw new Error("calendar_update_event requires at least one requested change.");
        }
        const url = calendarEventUrl(calendarId, eventId);
        url.searchParams.set("sendUpdates", "none");
        const result = asRecord(await calendarApiCall(context, connection, "PATCH", url, body));
        return {
          account: connectionLabel(connection),
          calendarId,
          event: compactEvent(result, connection, calendarId),
        };
      }),
  });
}

function deleteEventTool(
  context: CalendarRequestContext,
  mutationGuard: ReturnType<typeof createMutationGuard>,
) {
  return tool({
    description:
      "Delete one exact, previously confirmed event. Does not send attendee notifications.",
    inputSchema: jsonSchema<CalendarAccountInput & { calendarId?: string; eventId: string }>({
      type: "object",
      additionalProperties: false,
      properties: {
        account: accountProperty(),
        calendarId: calendarIdProperty(),
        eventId: { type: "string", minLength: 1, maxLength: 1_024 },
      },
      required: ["eventId"],
    }),
    execute: async (args) =>
      mutationGuard.run("calendar_delete_event", async () => {
        const connection = resolveConnection(context.connections, args.account, true);
        const calendarId = optionalTrimmed(args.calendarId, "calendarId", 1_024) ?? "primary";
        const eventId = requiredTrimmed(args.eventId, "eventId", 1_024);
        const url = calendarEventUrl(calendarId, eventId);
        url.searchParams.set("sendUpdates", "none");
        await calendarApiCall(context, connection, "DELETE", url);
        return {
          account: connectionLabel(connection),
          calendarId,
          deleted: true,
          entity: calendarEventEntity(connection, calendarId, eventId),
        };
      }),
  });
}

function resolveConnection(
  connections: readonly CalendarConnection[],
  account: string | undefined,
  requireWrite: boolean,
) {
  let connection: CalendarConnection | undefined;
  if (account?.trim()) {
    const wanted = account.trim().toLowerCase();
    connection = connections.find((entry) => entry.accountEmail?.toLowerCase() === wanted);
    if (!connection) {
      throw new Error(
        `No connected Google Calendar account matches ${JSON.stringify(account.trim())}. Connected accounts: ${connections
          .map((entry) => JSON.stringify(connectionLabel(entry)))
          .join(", ")}.`,
      );
    }
  } else if (connections.length === 1) {
    connection = connections[0];
  } else {
    throw new Error(
      `Multiple Google Calendar accounts are connected; pass account as one of: ${connections
        .map((entry) => JSON.stringify(connectionLabel(entry)))
        .join(", ")}.`,
    );
  }
  if (!connection) {
    throw new GoatCapabilityAuthError(
      "not_connected",
      "Google Calendar is not connected; connect it in Settings → Integrations.",
    );
  }
  if (requireWrite && !hasCalendarWriteScope(connection)) {
    throw new GoatCapabilityAuthError(
      "auth_expired",
      calendarReconnectHint(connection, "grant event edit access"),
    );
  }
  return connection;
}

async function calendarApiCall(
  context: CalendarRequestContext,
  connection: CalendarConnection,
  method: string,
  url: URL,
  body?: unknown,
) {
  const run = async (accessToken: string) =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal: context.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  let token = await getCalendarAccessToken(context, connection);
  let response = await run(token);
  if (response.status === 401) {
    token = await getCalendarAccessToken(context, connection, true);
    response = await run(token);
  }
  if (response.status === 204) return {};
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || isGooglePermissionError(response.status, text)) {
      await markCalendarNeedsReauth(context, connection, "Google rejected Calendar access.");
      throw new GoatCapabilityAuthError("auth_expired", calendarReconnectHint(connection));
    }
    throw new Error(`Google Calendar API request failed with ${response.status}.`);
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

async function getCalendarAccessToken(
  context: CalendarRequestContext,
  connection: CalendarConnection,
  forceRefresh = false,
) {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: context.userWorkosId,
    integrationId: connection.integrationId,
    provider: "google_calendar",
    kind: "oauth_token",
    db: getDb(),
  });
  if (!credential) {
    throw new GoatCapabilityAuthError("auth_expired", calendarReconnectHint(connection));
  }
  const tokens = credential.payload as StoredGoogleTokens;
  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now()
    : true;
  if (!forceRefresh && !expired && tokens.access_token) return tokens.access_token;
  if (!tokens.refresh_token) {
    await markCalendarNeedsReauth(
      context,
      connection,
      "Stored Google Calendar credentials have no refresh token.",
    );
    throw new GoatCapabilityAuthError("auth_expired", calendarReconnectHint(connection));
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured.");
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: context.signal,
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 && detail.includes("invalid_grant")) {
      await markCalendarNeedsReauth(context, connection, "Google refused the refresh token.");
      throw new GoatCapabilityAuthError("auth_expired", calendarReconnectHint(connection));
    }
    throw new Error(`Google token refresh failed with ${response.status}.`);
  }
  const refreshed = (await response.json()) as StoredGoogleTokens & { expires_in?: number };
  if (!refreshed.access_token) throw new Error("Google token refresh returned no access token.");
  const nextTokens: StoredGoogleTokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    ...((refreshed.scope ?? tokens.scope) ? { scope: refreshed.scope ?? tokens.scope } : {}),
    ...((refreshed.token_type ?? tokens.token_type)
      ? { token_type: refreshed.token_type ?? tokens.token_type }
      : {}),
  };
  await refreshGoatIntegrationCredential({
    userWorkosId: context.userWorkosId,
    integrationId: connection.integrationId,
    provider: "google_calendar",
    kind: "oauth_token",
    payload: Object.fromEntries(
      Object.entries(nextTokens).filter(([, value]) => value !== undefined),
    ),
    expiresAt:
      typeof refreshed.expires_in === "number"
        ? new Date(Date.now() + refreshed.expires_in * 1_000)
        : null,
    db: getDb(),
  });
  return refreshed.access_token;
}

async function markCalendarNeedsReauth(
  context: CalendarRequestContext,
  connection: CalendarConnection,
  reason: string,
) {
  await markGoatIntegrationStatus({
    userWorkosId: context.userWorkosId,
    integrationId: connection.integrationId,
    provider: "google_calendar",
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  });
}

function eventTimeBody(input: CalendarEventTimeInput) {
  if (input.allDay) {
    const start = validateDate(input.start, "start");
    const end = validateDate(input.end, "end");
    if (end <= start) throw new Error("An all-day event's exclusive end must be after start.");
    if (input.timeZone !== undefined) {
      throw new Error("All-day events do not accept timeZone; use YYYY-MM-DD dates.");
    }
    return { start: { date: start }, end: { date: end } };
  }
  const start = validateDateTime(input.start, "start", input.timeZone);
  const end = validateDateTime(input.end, "end", input.timeZone);
  if (Date.parse(end) <= Date.parse(start)) throw new Error("Event end must be after start.");
  const timeZone = optionalTrimmed(input.timeZone, "timeZone", 100);
  return {
    start: { dateTime: start, ...(timeZone ? { timeZone } : {}) },
    end: { dateTime: end, ...(timeZone ? { timeZone } : {}) },
  };
}

function validateTimeWindow(timeMin: string, timeMax: string) {
  const normalizedMin = validateDateTime(timeMin, "timeMin", undefined);
  const normalizedMax = validateDateTime(timeMax, "timeMax", undefined);
  const min = Date.parse(normalizedMin);
  const max = Date.parse(normalizedMax);
  if (max <= min) throw new Error("timeMax must be after timeMin.");
  return { timeMin: normalizedMin, timeMax: normalizedMax };
}

function validateDate(value: string, field: string) {
  const trimmed = requiredTrimmed(value, field, 10);
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== trimmed
  ) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date.`);
  }
  return trimmed;
}

function validateDateTime(value: string, field: string, timeZone: string | undefined) {
  const trimmed = requiredTrimmed(value, field, 100);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new Error(`${field} must be a valid date-time.`);
  }
  const hasOffset = /(Z|[+-]\d{2}:\d{2})$/i.test(trimmed);
  if (!hasOffset && !timeZone?.trim()) {
    throw new Error(`${field} must include an RFC 3339 offset or be paired with timeZone.`);
  }
  if (timeZone) validateTimeZone(timeZone);
  return trimmed;
}

function validateTimeZone(value: string) {
  const timeZone = requiredTrimmed(value, "timeZone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new Error("timeZone must be a valid IANA time zone.");
  }
}

function compactCalendar(calendar: Record<string, unknown>) {
  return {
    id: readString(calendar.id),
    summary: readString(calendar.summary),
    description: truncate(readString(calendar.description), 300),
    primary: calendar.primary === true || undefined,
    accessRole: readString(calendar.accessRole),
    timeZone: readString(calendar.timeZone),
    selected: calendar.selected === true || undefined,
  };
}

function compactEvent(
  event: Record<string, unknown>,
  connection: CalendarConnection,
  calendarId: string,
) {
  const eventId = readString(event.id) ?? "unknown";
  const url = readString(event.htmlLink);
  const title = readString(event.summary);
  return {
    id: eventId,
    status: readString(event.status),
    summary: title,
    description: truncate(readString(event.description), MAX_EVENT_DESCRIPTION_RESULT_CHARS),
    location: truncate(readString(event.location), 500),
    htmlLink: url,
    start: asRecord(event.start),
    end: asRecord(event.end),
    organizer: compactPerson(asRecord(event.organizer)),
    attendees: asArray(event.attendees)
      .slice(0, 20)
      .map((value) => compactPerson(asRecord(value))),
    entity: calendarEventEntity(connection, calendarId, eventId, url, title),
  };
}

function compactPerson(person: Record<string, unknown>) {
  return {
    email: readString(person.email),
    displayName: readString(person.displayName),
    responseStatus: readString(person.responseStatus),
  };
}

function calendarEventEntity(
  connection: CalendarConnection,
  calendarId: string,
  eventId: string,
  url?: string,
  title?: string,
) {
  return {
    type: "google_calendar_event",
    id: `${connection.integrationId}:${calendarId}:${eventId}`,
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  };
}

function calendarEventsUrl(calendarId: string) {
  return new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
}

function calendarEventUrl(calendarId: string, eventId: string) {
  return new URL(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
}

function createMutationGuard() {
  let attempted = false;
  return {
    async run<T>(toolName: string, execute: () => Promise<T>) {
      if (attempted) {
        throw new Error(
          `A Google Calendar mutation was already attempted; ${toolName} will not run because mutations are never retried or chained in one worker call.`,
        );
      }
      attempted = true;
      return execute();
    },
  };
}

function accountInputSchema() {
  return jsonSchema<CalendarAccountInput>({
    type: "object",
    additionalProperties: false,
    properties: { account: accountProperty() },
  });
}

function accountProperty() {
  return {
    type: "string" as const,
    minLength: 1,
    maxLength: 320,
    description: "Connected Google account email. Required when multiple accounts are connected.",
  };
}

function calendarIdProperty() {
  return {
    type: "string" as const,
    minLength: 1,
    maxLength: 1_024,
    description: 'Calendar id. Defaults to "primary".',
  };
}

function eventStartProperty() {
  return {
    type: "string" as const,
    description: "RFC 3339 date-time, or YYYY-MM-DD when allDay is true.",
  };
}

function eventEndProperty() {
  return {
    type: "string" as const,
    description: "RFC 3339 date-time, or exclusive YYYY-MM-DD end date when allDay is true.",
  };
}

function timeZoneProperty() {
  return {
    type: "string" as const,
    minLength: 1,
    maxLength: 100,
    description: 'IANA time zone such as "Europe/London". Omit for offset date-times.',
  };
}

function requiredTrimmed(value: unknown, field: string, maxChars: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const trimmed = value.trim();
  if (trimmed.length > maxChars) throw new Error(`${field} exceeds ${maxChars} characters.`);
  return trimmed;
}

function optionalTrimmed(value: unknown, field: string, maxChars: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > maxChars) throw new Error(`${field} exceeds ${maxChars} characters.`);
  return trimmed;
}

function formatAccountLabel(connections: readonly CalendarConnection[]) {
  if (connections.length === 1) {
    return ` for account ${JSON.stringify(connectionLabel(connections[0]!))}`;
  }
  return ` for ${connections.length} connected accounts`;
}

function connectionLabel(connection: CalendarConnection) {
  const label = connection.accountEmail?.trim() || connection.accountName?.trim();
  if (!label) return "Google account";
  const normalized = label.replace(/\s+/g, " ");
  return normalized.length > 100 ? `${normalized.slice(0, 100)}…` : normalized;
}

function calendarReconnectHint(connection: CalendarConnection, reason?: string) {
  return `Reconnect Google Calendar for ${connectionLabel(connection)}${
    reason ? ` to ${reason}` : ""
  } in Settings → Integrations using “Reconnect or add”, then select the same Google account.`;
}

function isGooglePermissionError(status: number, body: string) {
  return (
    status === 403 &&
    (body.includes("insufficientPermissions") || body.includes("insufficient_scope"))
  );
}

function clampCount(value: number | undefined, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function truncate(value: string | undefined, maxChars: number) {
  if (value === undefined) return undefined;
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
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
