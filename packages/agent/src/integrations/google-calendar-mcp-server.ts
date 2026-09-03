import { isPluginGatewayRegistrationActive } from "@opencompany/db/plugin-gateway-repository";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  type CapabilityId,
  effectiveCapabilityMode,
  isCapabilityMode,
} from "../actions/capabilities";
import { truncateText } from "../actions/types";
import { GoogleAccessAuthError, googleApiCall } from "./google-access-token";
import {
  type GoogleCalendarMcpTicketPayload,
  verifyGoogleCalendarMcpTicket,
} from "./google-calendar-mcp-ticket";
import { googleCalendarMcpScopesSatisfied } from "./google-calendar-scopes";
import { loadGoogleCalendarIntegration } from "./google-data";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const MCP_MAX_DURATION_SECONDS = 120;
const MAX_CALENDAR_ID_CHARS = 1_024;
const MAX_EVENT_ATTENDEES = 20;

const TOOL_CAPABILITIES = {
  list_calendars: "read",
  list_events: "query",
  get_event: "query",
  create_event: "write",
} as const satisfies Record<string, CapabilityId>;

type GoogleCalendarMcpToolName = keyof typeof TOOL_CAPABILITIES;
type DbLike = any;

type CalendarApiCall = typeof googleApiCall;

export type GoogleCalendarMcpService = {
  handle(request: Request): Promise<Response>;
};

const calendarIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CALENDAR_ID_CHARS)
  .optional()
  .describe('Calendar id. Defaults to "primary".');

const pageSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(250)
  .optional()
  .describe("Maximum results to return (default 10, max 250).");

const pageTokenSchema = z.string().trim().min(1).max(2_048).optional();

const listCalendarsSchema = {
  pageSize: pageSizeSchema,
  pageToken: pageTokenSchema,
};

const listEventsSchema = {
  calendarId: calendarIdSchema,
  pageSize: pageSizeSchema,
  pageToken: pageTokenSchema,
  startTime: z.string().trim().min(1).max(100).optional(),
  endTime: z.string().trim().min(1).max(100).optional(),
  timeZone: z.string().trim().min(1).max(100).optional(),
  orderBy: z.enum(["default", "startTime", "startTimeDesc", "lastModified"]).optional(),
  fullText: z.string().trim().min(1).max(500).optional(),
  eventType: z
    .array(
      z.enum(["birthday", "default", "focusTime", "fromGmail", "outOfOffice", "workingLocation"]),
    )
    .max(6)
    .optional(),
};

const getEventSchema = {
  eventId: z.string().trim().min(1).max(1_024),
  calendarId: calendarIdSchema,
};

const attendeeSchema = z
  .object({
    email: z.string().email().max(320),
    displayName: z.string().trim().min(1).max(200).optional(),
    optionalAttendee: z.boolean().optional(),
  })
  .strict();

const createEventSchema = {
  summary: z.string().trim().min(1).max(300),
  startTime: z.string().trim().min(1).max(100),
  endTime: z.string().trim().min(1).max(100),
  calendarId: calendarIdSchema,
  description: z.string().trim().min(1).max(1_000).optional(),
  location: z.string().trim().min(1).max(500).optional(),
  allDay: z.boolean().optional(),
  timeZone: z.string().trim().min(1).max(100).optional(),
  attendees: z.array(attendeeSchema).max(MAX_EVENT_ATTENDEES).optional(),
  notificationLevel: z
    .enum(["NOTIFICATION_LEVEL_UNSPECIFIED", "NONE", "EXTERNAL_ONLY", "ALL"])
    .optional(),
};

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CREATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function createGoogleCalendarMcpService(input: {
  db: DbLike;
  internalSecret: string;
  calendarApiCall?: CalendarApiCall;
}): GoogleCalendarMcpService {
  const calendarApiCall = input.calendarApiCall ?? googleApiCall;
  return {
    async handle(request) {
      const ticket = bearerToken(request);
      if (!ticket) return unauthorized("A Google Calendar MCP bearer ticket is required.");
      const payload = verifyGoogleCalendarMcpTicket({ ticket, secret: input.internalSecret });
      if (!payload) return unauthorized("The Google Calendar MCP bearer ticket is invalid.");

      const requestPolicy = await authorizeRequest(request, payload);
      if (!requestPolicy.ok) return requestPolicy.response;

      const authorization = await authorizeTicket(input.db, payload);
      if (!authorization.ok) return authorization.response;

      const handler = createMcpHandler(
        (server) => {
          server.registerTool(
            "list_calendars",
            {
              title: "List calendars",
              description: "List calendars available to the connected Google account.",
              inputSchema: listCalendarsSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => listCalendars(calendarApiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "list_events",
            {
              title: "List events",
              description:
                "List events from a Google Calendar, optionally constrained by time, text, and event type.",
              inputSchema: listEventsSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => listEvents(calendarApiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "get_event",
            {
              title: "Get event",
              description: "Get one Google Calendar event by id.",
              inputSchema: getEventSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) => runTool(() => getEvent(calendarApiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "create_event",
            {
              title: "Create event",
              description:
                "Create an event in Google Calendar. Attendee notifications default to all recipients.",
              inputSchema: createEventSchema,
              annotations: CREATE_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => createEvent(calendarApiCall, payload, args, request.signal)),
          );
        },
        {
          serverInfo: { name: "opencompany-google-calendar", version: "0.1.0" },
          instructions:
            "Use list_calendars to resolve calendar ids, list_events or get_event to inspect events, and create_event only after the user requested a calendar write.",
        },
        {
          streamableHttpEndpoint: "/mcp/plugins/google-calendar",
          disableSse: true,
          maxDuration: MCP_MAX_DURATION_SECONDS,
        },
      );

      try {
        return await handler(request);
      } catch (error) {
        if (error instanceof GoogleAccessAuthError) {
          return unauthorized("The connected Google Calendar account must be reauthorized.");
        }
        throw error;
      }
    },
  };
}

async function authorizeTicket(db: DbLike, payload: GoogleCalendarMcpTicketPayload) {
  const [active, row] = await Promise.all([
    isPluginGatewayRegistrationActive(db, {
      workspaceId: payload.workspaceId,
      registrationId: payload.registrationId,
    }),
    loadGoogleCalendarIntegration({ userWorkosId: payload.userWorkosId }),
  ]);
  if (!active) return forbidden("The Google Calendar plugin is no longer enabled.");
  if (
    !row ||
    row.id !== payload.integrationId ||
    row.status !== "connected" ||
    !googleCalendarMcpScopesSatisfied(row.scopes ?? [])
  ) {
    return {
      ok: false as const,
      response: unauthorized("The connected Google Calendar account must be reauthorized."),
    };
  }
  if (payload.operation.type === "tools/call") {
    const capability = TOOL_CAPABILITIES[payload.operation.tool as GoogleCalendarMcpToolName];
    if (!capability || capability !== payload.operation.capability) {
      return forbidden("The Google Calendar MCP ticket does not authorize this tool.");
    }
    const toolMode = row.toolModes?.[payload.operation.tool];
    const mode = isCapabilityMode(toolMode)
      ? toolMode
      : effectiveCapabilityMode("google_calendar", capability, row.capabilityModes);
    if (mode === "off") {
      return forbidden("This Google Calendar capability is disabled.");
    }
  }
  return { ok: true as const };
}

async function authorizeRequest(request: Request, payload: GoogleCalendarMcpTicketPayload) {
  if (request.method !== "POST") {
    return { ok: false as const, response: methodNotAllowed() };
  }
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return { ok: false as const, response: badRequest("A JSON-RPC request body is required.") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false as const, response: badRequest("JSON-RPC batches are not supported.") };
  }
  const rpc = body as Record<string, unknown>;
  const method = typeof rpc.method === "string" ? rpc.method : "";
  if (
    ["initialize", "notifications/initialized", "notifications/cancelled", "ping"].includes(method)
  ) {
    return { ok: true as const };
  }
  if (method === "tools/list" && payload.operation.type === "tools/list") {
    return { ok: true as const };
  }
  if (method === "tools/call" && payload.operation.type === "tools/call") {
    const params = rpc.params;
    if (
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      (params as Record<string, unknown>).name === payload.operation.tool
    ) {
      return { ok: true as const };
    }
  }
  return {
    ok: false as const,
    response: forbidden("The Google Calendar MCP ticket does not authorize this operation.")
      .response,
  };
}

async function listCalendars(
  apiCall: CalendarApiCall,
  payload: GoogleCalendarMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof listCalendarsSchema>>,
  signal: AbortSignal,
) {
  const pageSize = args.pageSize ?? 10;
  const url = new URL(`${CALENDAR_BASE}/users/me/calendarList`);
  url.searchParams.set("maxResults", String(pageSize));
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set(
    "fields",
    "nextPageToken,items(id,summary,description,timeZone,accessRole,primary,selected)",
  );
  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
  const response = asRecord(await callGoogle(apiCall, payload, "GET", url, signal));
  return {
    calendars: asArray(response.items)
      .slice(0, pageSize)
      .map((item) => compactCalendar(asRecord(item))),
    nextPageToken: boundedString(response.nextPageToken, 2_048),
  };
}

async function listEvents(
  apiCall: CalendarApiCall,
  payload: GoogleCalendarMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof listEventsSchema>>,
  signal: AbortSignal,
) {
  const calendarId = args.calendarId ?? "primary";
  const pageSize = args.pageSize ?? 10;
  const startTime = args.startTime ? rfc3339(args.startTime, "startTime") : undefined;
  const endTime = args.endTime ? rfc3339(args.endTime, "endTime") : undefined;
  if (startTime && endTime && Date.parse(endTime) <= Date.parse(startTime)) {
    throw new Error('"endTime" must be after "startTime".');
  }
  if (args.timeZone) assertTimezone(args.timeZone);

  const url = new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("maxResults", String(pageSize));
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set(
    "fields",
    "nextPageToken,timeZone,items(id,status,summary,description,location,htmlLink,hangoutLink,created,updated,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,optional))",
  );
  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
  if (startTime) url.searchParams.set("timeMin", startTime);
  if (endTime) url.searchParams.set("timeMax", endTime);
  if (args.timeZone) url.searchParams.set("timeZone", args.timeZone);
  if (args.fullText) url.searchParams.set("q", args.fullText);
  for (const eventType of args.eventType ?? []) url.searchParams.append("eventTypes", eventType);
  if (args.orderBy === "startTime" || args.orderBy === "startTimeDesc") {
    url.searchParams.set("orderBy", "startTime");
  } else if (args.orderBy === "lastModified") {
    url.searchParams.set("orderBy", "updated");
  }

  const response = asRecord(await callGoogle(apiCall, payload, "GET", url, signal));
  const events = asArray(response.items)
    .slice(0, pageSize)
    .map((event) => compactEvent(asRecord(event)));
  if (args.orderBy === "startTimeDesc") events.reverse();
  return {
    calendarId,
    timeZone: boundedString(response.timeZone, 100),
    events,
    nextPageToken: boundedString(response.nextPageToken, 2_048),
  };
}

async function getEvent(
  apiCall: CalendarApiCall,
  payload: GoogleCalendarMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof getEventSchema>>,
  signal: AbortSignal,
) {
  const calendarId = args.calendarId ?? "primary";
  const url = new URL(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(args.eventId)}`,
  );
  url.searchParams.set(
    "fields",
    "id,status,summary,description,location,htmlLink,hangoutLink,created,updated,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,optional)",
  );
  const response = asRecord(await callGoogle(apiCall, payload, "GET", url, signal));
  return { calendarId, event: compactEvent(response) };
}

async function createEvent(
  apiCall: CalendarApiCall,
  payload: GoogleCalendarMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof createEventSchema>>,
  signal: AbortSignal,
) {
  const calendarId = args.calendarId ?? "primary";
  const times = eventTimes(args);
  const url = new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("sendUpdates", sendUpdates(args.notificationLevel));
  url.searchParams.set(
    "fields",
    "id,status,summary,description,location,htmlLink,hangoutLink,created,updated,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,optional)",
  );
  const response = asRecord(
    await callGoogle(apiCall, payload, "POST", url, signal, {
      summary: args.summary,
      ...(args.description ? { description: args.description } : {}),
      ...(args.location ? { location: args.location } : {}),
      ...times,
      ...(args.attendees
        ? {
            attendees: args.attendees.map((attendee) => ({
              email: attendee.email,
              ...(attendee.displayName ? { displayName: attendee.displayName } : {}),
              ...(attendee.optionalAttendee !== undefined
                ? { optional: attendee.optionalAttendee }
                : {}),
            })),
          }
        : {}),
    }),
  );
  return { calendarId, event: compactEvent(response) };
}

async function callGoogle(
  apiCall: CalendarApiCall,
  payload: GoogleCalendarMcpTicketPayload,
  method: "GET" | "POST",
  url: URL,
  signal: AbortSignal,
  body?: unknown,
) {
  return await apiCall(
    {
      userWorkosId: payload.userWorkosId,
      integrationId: payload.integrationId,
      provider: "google_calendar",
    },
    method,
    url,
    { signal, ...(body !== undefined ? { body } : {}) },
  );
}

function eventTimes(args: z.infer<z.ZodObject<typeof createEventSchema>>) {
  const startDate = plainDate(args.startTime);
  const endDate = plainDate(args.endTime);
  const allDay = args.allDay ?? Boolean(startDate && endDate);
  if (allDay) {
    if (!startDate || !endDate) {
      throw new Error('All-day "startTime" and "endTime" must be YYYY-MM-DD dates.');
    }
    if (args.timeZone) throw new Error('"timeZone" must be omitted for all-day events.');
    const startMs = Date.UTC(startDate.year, startDate.month - 1, startDate.day);
    const endMs = Date.UTC(endDate.year, endDate.month - 1, endDate.day);
    if (endMs < startMs) throw new Error('"endTime" must not be before "startTime".');
    const exclusiveEnd = endMs === startMs ? addDays(endDate, 1) : endDate;
    return { start: { date: formatDate(startDate) }, end: { date: formatDate(exclusiveEnd) } };
  }
  if (startDate || endDate) {
    throw new Error('Timed "startTime" and "endTime" must be RFC 3339 timestamps.');
  }
  const startTime = rfc3339(args.startTime, "startTime");
  const endTime = rfc3339(args.endTime, "endTime");
  if (Date.parse(endTime) <= Date.parse(startTime)) {
    throw new Error('"endTime" must be after "startTime".');
  }
  if (args.timeZone) assertTimezone(args.timeZone);
  return {
    start: { dateTime: startTime, ...(args.timeZone ? { timeZone: args.timeZone } : {}) },
    end: { dateTime: endTime, ...(args.timeZone ? { timeZone: args.timeZone } : {}) },
  };
}

function sendUpdates(level: z.infer<typeof createEventSchema.notificationLevel>) {
  if (level === "NONE") return "none";
  if (level === "EXTERNAL_ONLY") return "externalOnly";
  return "all";
}

function rfc3339(value: string, field: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/iu.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`"${field}" must be an RFC 3339 timestamp with a UTC offset.`);
  }
  return value;
}

function assertTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw new Error(`"timeZone" must be a valid IANA timezone, got ${JSON.stringify(value)}.`);
  }
}

type CalendarDate = { year: number; month: number; day: number };

function plainDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const instant = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return instant.getUTCFullYear() === date.year &&
    instant.getUTCMonth() === date.month - 1 &&
    instant.getUTCDate() === date.day
    ? date
    : null;
}

function addDays(value: CalendarDate, days: number): CalendarDate {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function formatDate(value: CalendarDate) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function compactCalendar(value: Record<string, unknown>) {
  return {
    id: boundedString(value.id, MAX_CALENDAR_ID_CHARS),
    summary: truncateText(string(value.summary), 300),
    description: truncateText(string(value.description), 1_000),
    timeZone: boundedString(value.timeZone, 100),
    accessRole: boundedString(value.accessRole, 50),
    primary: value.primary === true || undefined,
    selected: value.selected === true || undefined,
  };
}

function compactEvent(value: Record<string, unknown>) {
  return {
    id: boundedString(value.id, 1_024),
    status: boundedString(value.status, 50),
    summary: truncateText(string(value.summary), 300),
    description: truncateText(string(value.description), 1_000),
    location: truncateText(string(value.location), 500),
    htmlLink: googleUrl(value.htmlLink),
    hangoutLink: googleUrl(value.hangoutLink),
    created: boundedString(value.created, 100),
    updated: boundedString(value.updated, 100),
    start: compactTime(asRecord(value.start)),
    end: compactTime(asRecord(value.end)),
    organizer: compactPerson(asRecord(value.organizer)),
    attendees: asArray(value.attendees)
      .slice(0, MAX_EVENT_ATTENDEES)
      .map((attendee) => compactPerson(asRecord(attendee))),
  };
}

function compactTime(value: Record<string, unknown>) {
  return {
    date: boundedString(value.date, 10),
    dateTime: boundedString(value.dateTime, 100),
    timeZone: boundedString(value.timeZone, 100),
  };
}

function compactPerson(value: Record<string, unknown>) {
  return {
    email: boundedString(value.email, 320),
    displayName: truncateText(string(value.displayName), 200),
    responseStatus: boundedString(value.responseStatus, 50),
    self: value.self === true || undefined,
    optional: value.optional === true || undefined,
  };
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function runTool(run: () => Promise<unknown>) {
  try {
    return toolResult(await run());
  } catch (error) {
    if (error instanceof GoogleAccessAuthError) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: {
                code: "auth_expired",
                message: "The connected Google Calendar account must be reauthorized.",
              },
            }),
          },
        ],
      };
    }
    throw error;
  }
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

function unauthorized(message: string) {
  return Response.json(
    { error: message },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="google-calendar-mcp"' } },
  );
}

function forbidden(message: string) {
  return { ok: false as const, response: Response.json({ error: message }, { status: 403 }) };
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

function methodNotAllowed() {
  return Response.json({ error: "Only POST is supported." }, { status: 405 });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function boundedString(value: unknown, maxChars: number) {
  const result = string(value);
  return result && result.length <= maxChars ? result : undefined;
}

function googleUrl(value: unknown) {
  const candidate = boundedString(value, 2_048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" &&
      (url.hostname === "google.com" || url.hostname.endsWith(".google.com"))
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
