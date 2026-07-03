import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  refreshGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import type { GoatIntegrationProvider } from "@opencompany/db/goat-schema";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";

export type GoatGoogleToolName =
  | "gmail_search"
  | "gmail_get_message"
  | "gmail_list_threads"
  | "gmail_get_thread"
  | "calendar_list_calendars"
  | "calendar_list_events"
  | "calendar_get_event"
  | "calendar_get_freebusy";

const GMAIL_TOOLS = new Set<GoatGoogleToolName>([
  "gmail_search",
  "gmail_get_message",
  "gmail_list_threads",
  "gmail_get_thread",
]);

const CALENDAR_TOOLS = new Set<GoatGoogleToolName>([
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_get_event",
  "calendar_get_freebusy",
]);

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const REFRESH_SKEW_MS = 60_000;
const MAX_MESSAGE_BODY_CHARS = 12_000;

type ResolvedAccount = {
  integrationId: string;
  provider: GoatIntegrationProvider;
  accountEmail: string | null;
};

type StoredGoogleTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export function isGoatGoogleToolName(name: string): name is GoatGoogleToolName {
  return (
    GMAIL_TOOLS.has(name as GoatGoogleToolName) || CALENDAR_TOOLS.has(name as GoatGoogleToolName)
  );
}

export async function executeGoatGoogleTool(input: {
  name: GoatGoogleToolName;
  args: unknown;
  userWorkosId: string;
  env: RunnerEnv;
  signal: AbortSignal;
}) {
  const provider: GoatIntegrationProvider = GMAIL_TOOLS.has(input.name)
    ? "gmail"
    : "google_calendar";
  const args = asRecord(input.args);
  const account = await resolveAccount({
    userWorkosId: input.userWorkosId,
    provider,
    accountArg: readString(args, "account"),
  });

  return dispatchGoogleTool({
    name: input.name,
    args,
    env: input.env,
    userWorkosId: input.userWorkosId,
    account,
    signal: input.signal,
  });
}

async function resolveAccount(input: {
  userWorkosId: string;
  provider: GoatIntegrationProvider;
  accountArg: string | undefined;
}): Promise<ResolvedAccount> {
  const rows = await getDb()
    .select({
      id: goatIntegrations.id,
      accountEmail: goatIntegrations.accountEmail,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, input.userWorkosId),
        eq(goatIntegrations.provider, input.provider),
        ne(goatIntegrations.status, "disconnected"),
      ),
    );

  const connected = rows.filter((row) => row.status === "connected");
  if (connected.length === 0) {
    throw new Error(`Reconnect ${displayName(input.provider)} in Settings before using this tool.`);
  }

  if (input.accountArg) {
    const wanted = input.accountArg.trim().toLowerCase();
    const match = connected.find((row) => (row.accountEmail ?? "").toLowerCase() === wanted);
    if (!match) {
      throw new Error(
        `No connected ${displayName(input.provider)} account matches "${input.accountArg}".`,
      );
    }
    return { integrationId: match.id, provider: input.provider, accountEmail: match.accountEmail };
  }

  if (connected.length > 1) {
    throw new Error(
      `Multiple ${displayName(input.provider)} accounts are connected; pass "account" to choose one.`,
    );
  }

  const only = connected[0]!;
  return { integrationId: only.id, provider: input.provider, accountEmail: only.accountEmail };
}

async function dispatchGoogleTool(input: {
  name: GoatGoogleToolName;
  args: Record<string, unknown>;
  env: RunnerEnv;
  userWorkosId: string;
  account: ResolvedAccount;
  signal: AbortSignal;
}) {
  const call = (method: string, url: string, body?: unknown) =>
    googleApiCall({
      env: input.env,
      userWorkosId: input.userWorkosId,
      account: input.account,
      method,
      url,
      signal: input.signal,
      ...(body !== undefined ? { body } : {}),
    });

  switch (input.name) {
    case "gmail_search":
      return gmailListMessages({ args: input.args, call, requireQuery: true });
    case "gmail_get_message":
      return gmailGetMessage({ args: input.args, call });
    case "gmail_list_threads":
      return gmailListThreads({ args: input.args, call });
    case "gmail_get_thread":
      return gmailGetThread({ args: input.args, call });
    case "calendar_list_calendars":
      return calendarListCalendars({ call });
    case "calendar_list_events":
      return calendarListEvents({ args: input.args, call });
    case "calendar_get_event":
      return calendarGetEvent({ args: input.args, call });
    case "calendar_get_freebusy":
      return calendarFreeBusy({ args: input.args, call });
  }
}

type Caller = (method: string, url: string, body?: unknown) => Promise<unknown>;

async function getAccessToken(input: {
  env: RunnerEnv;
  userWorkosId: string;
  account: ResolvedAccount;
  signal: AbortSignal;
  forceRefresh?: boolean;
}) {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.account.integrationId,
    provider: input.account.provider,
    kind: "oauth_token",
    db: getDb(),
  });
  if (!credential) {
    throw new Error(`Reconnect ${displayName(input.account.provider)} in Settings.`);
  }

  const tokens = credential.payload as StoredGoogleTokens;
  const expired = credential.expiresAt
    ? credential.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now()
    : true;
  if (!input.forceRefresh && !expired && tokens.access_token) return tokens.access_token;

  if (!tokens.refresh_token) {
    await markNeedsReauth(input, "Stored Google credentials have no refresh token.");
    throw new Error(`Reconnect ${displayName(input.account.provider)} in Settings.`);
  }

  return refreshAccessToken(input, tokens);
}

async function refreshAccessToken(
  input: {
    env: RunnerEnv;
    userWorkosId: string;
    account: ResolvedAccount;
    signal: AbortSignal;
  },
  tokens: StoredGoogleTokens,
) {
  if (!input.env.googleOAuthClientId || !input.env.googleOAuthClientSecret) {
    throw new Error("Google OAuth is not configured on the runner.");
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: input.signal,
    body: new URLSearchParams({
      client_id: input.env.googleOAuthClientId,
      client_secret: input.env.googleOAuthClientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 && detail.includes("invalid_grant")) {
      await markNeedsReauth(input, "Google refused the refresh token.");
      throw new Error(`Reconnect ${displayName(input.account.provider)} in Settings.`);
    }
    throw new Error(`Google token refresh failed with ${response.status}.`);
  }

  const result = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
  };
  if (!result.access_token) throw new Error("Google token refresh did not return an access token.");

  const nextTokens: StoredGoogleTokens = {
    access_token: result.access_token,
    ...((result.refresh_token ?? tokens.refresh_token)
      ? { refresh_token: result.refresh_token ?? tokens.refresh_token }
      : {}),
    ...((result.scope ?? tokens.scope) ? { scope: result.scope ?? tokens.scope } : {}),
    ...((result.token_type ?? tokens.token_type)
      ? { token_type: result.token_type ?? tokens.token_type }
      : {}),
  };
  const expiresAt =
    typeof result.expires_in === "number" ? new Date(Date.now() + result.expires_in * 1000) : null;

  await refreshGoatIntegrationCredential({
    userWorkosId: input.userWorkosId,
    integrationId: input.account.integrationId,
    provider: input.account.provider,
    kind: "oauth_token",
    payload: stripUndefined(nextTokens),
    expiresAt,
    db: getDb(),
  });

  return result.access_token;
}

async function markNeedsReauth(
  input: { userWorkosId: string; account: ResolvedAccount },
  reason: string,
) {
  await markGoatIntegrationStatus({
    userWorkosId: input.userWorkosId,
    integrationId: input.account.integrationId,
    provider: input.account.provider,
    status: "needs_reauth",
    statusReason: reason,
    db: getDb(),
  });
}

async function googleApiCall(input: {
  env: RunnerEnv;
  userWorkosId: string;
  account: ResolvedAccount;
  method: string;
  url: string;
  body?: unknown;
  signal: AbortSignal;
}): Promise<unknown> {
  const run = async (token: string) =>
    fetch(input.url, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal: input.signal,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });

  let token = await getAccessToken(input);
  let response = await run(token);
  if (response.status === 401) {
    token = await getAccessToken({ ...input, forceRefresh: true });
    response = await run(token);
  }

  if (response.status === 204) return {};
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${displayName(input.account.provider)} API request failed with ${response.status}: ${truncate(text, 300)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

async function gmailListMessages(input: {
  args: Record<string, unknown>;
  call: Caller;
  requireQuery: boolean;
}) {
  const query = readString(input.args, "query");
  if (input.requireQuery && !query) throw new Error("gmail_search requires a query.");
  const maxResults = clampInt(readNumber(input.args, "maxResults"), 10, 1, 50);
  const url = new URL(`${GMAIL_BASE}/messages`);
  url.searchParams.set("maxResults", String(maxResults));
  if (query) url.searchParams.set("q", query);
  for (const labelId of asArray(input.args.labelIds)) {
    if (typeof labelId === "string") url.searchParams.append("labelIds", labelId);
  }

  const list = asRecord(await input.call("GET", url.toString()));
  const ids = asArray(list.messages)
    .map((entry) => readString(asRecord(entry), "id"))
    .filter((id): id is string => Boolean(id));

  const messages = await Promise.all(
    ids.map(async (id) => {
      const detailUrl = new URL(`${GMAIL_BASE}/messages/${id}`);
      detailUrl.searchParams.set("format", "metadata");
      for (const header of ["From", "To", "Subject", "Date"]) {
        detailUrl.searchParams.append("metadataHeaders", header);
      }
      return summarizeMessage(asRecord(await input.call("GET", detailUrl.toString())));
    }),
  );

  return {
    messages,
    resultSizeEstimate: readNumber(list, "resultSizeEstimate") ?? messages.length,
  };
}

async function gmailGetMessage(input: { args: Record<string, unknown>; call: Caller }) {
  const messageId = requireString(input.args, "messageId");
  const url = new URL(`${GMAIL_BASE}/messages/${messageId}`);
  url.searchParams.set("format", "full");
  return parseFullMessage(asRecord(await input.call("GET", url.toString())));
}

async function gmailListThreads(input: { args: Record<string, unknown>; call: Caller }) {
  const query = readString(input.args, "query");
  const maxResults = clampInt(readNumber(input.args, "maxResults"), 10, 1, 50);
  const url = new URL(`${GMAIL_BASE}/threads`);
  url.searchParams.set("maxResults", String(maxResults));
  if (query) url.searchParams.set("q", query);
  const list = asRecord(await input.call("GET", url.toString()));
  return {
    threads: asArray(list.threads).map((thread) => {
      const record = asRecord(thread);
      return {
        id: readString(record, "id"),
        snippet: readString(record, "snippet"),
      };
    }),
    resultSizeEstimate: readNumber(list, "resultSizeEstimate"),
  };
}

async function gmailGetThread(input: { args: Record<string, unknown>; call: Caller }) {
  const threadId = requireString(input.args, "threadId");
  const url = new URL(`${GMAIL_BASE}/threads/${threadId}`);
  url.searchParams.set("format", "full");
  const thread = asRecord(await input.call("GET", url.toString()));
  return {
    id: readString(thread, "id"),
    historyId: readString(thread, "historyId"),
    messages: asArray(thread.messages).map((message) => parseFullMessage(asRecord(message))),
  };
}

function summarizeMessage(message: Record<string, unknown>) {
  return {
    id: readString(message, "id"),
    threadId: readString(message, "threadId"),
    snippet: readString(message, "snippet"),
    historyId: readString(message, "historyId"),
    internalDate: readString(message, "internalDate"),
    headers: readHeaders(asRecord(message.payload)),
    labelIds: asArray(message.labelIds).filter(
      (label): label is string => typeof label === "string",
    ),
  };
}

function parseFullMessage(message: Record<string, unknown>) {
  const payload = asRecord(message.payload);
  return {
    ...summarizeMessage(message),
    body: truncate(collectTextParts(payload).join("\n\n").trim(), MAX_MESSAGE_BODY_CHARS),
  };
}

function readHeaders(payload: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  for (const header of asArray(payload.headers)) {
    const record = asRecord(header);
    const name = readString(record, "name");
    const value = readString(record, "value");
    if (name && value && ["from", "to", "cc", "subject", "date"].includes(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return headers;
}

function collectTextParts(part: Record<string, unknown>): string[] {
  const mimeType = readString(part, "mimeType");
  const body = asRecord(part.body);
  const data = readString(body, "data");
  const current = data && (!mimeType || mimeType === "text/plain") ? [decodeBase64Url(data)] : [];
  const children = asArray(part.parts).flatMap((child) => collectTextParts(asRecord(child)));
  return [...current, ...children].filter((text) => text.trim());
}

async function calendarListCalendars(input: { call: Caller }) {
  const url = new URL(`${CALENDAR_BASE}/users/me/calendarList`);
  url.searchParams.set("maxResults", "100");
  url.searchParams.set("showHidden", "false");
  const list = asRecord(await input.call("GET", url.toString()));
  return {
    calendars: asArray(list.items).map((item) => summarizeCalendar(asRecord(item))),
  };
}

async function calendarListEvents(input: { args: Record<string, unknown>; call: Caller }) {
  const calendarId = encodeURIComponent(readString(input.args, "calendarId") ?? "primary");
  const url = new URL(`${CALENDAR_BASE}/calendars/${calendarId}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set(
    "maxResults",
    String(clampInt(readNumber(input.args, "maxResults"), 20, 1, 50)),
  );
  const timeMin = readString(input.args, "timeMin");
  const timeMax = readString(input.args, "timeMax");
  const query = readString(input.args, "query");
  if (timeMin) url.searchParams.set("timeMin", timeMin);
  if (timeMax) url.searchParams.set("timeMax", timeMax);
  if (query) url.searchParams.set("q", query);
  const result = asRecord(await input.call("GET", url.toString()));
  return {
    calendarId: decodeURIComponent(calendarId),
    events: asArray(result.items).map((event) => summarizeEvent(asRecord(event))),
  };
}

async function calendarGetEvent(input: { args: Record<string, unknown>; call: Caller }) {
  const calendarId = encodeURIComponent(readString(input.args, "calendarId") ?? "primary");
  const eventId = encodeURIComponent(requireString(input.args, "eventId"));
  return summarizeEvent(
    asRecord(await input.call("GET", `${CALENDAR_BASE}/calendars/${calendarId}/events/${eventId}`)),
  );
}

async function calendarFreeBusy(input: { args: Record<string, unknown>; call: Caller }) {
  const timeMin = requireString(input.args, "timeMin");
  const timeMax = requireString(input.args, "timeMax");
  const calendarIds = asArray(input.args.calendarIds)
    .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
    .map((id) => id.trim());
  const items = (calendarIds.length > 0 ? calendarIds : ["primary"]).map((id) => ({ id }));
  const result = asRecord(
    await input.call("POST", `${CALENDAR_BASE}/freeBusy`, {
      timeMin,
      timeMax,
      items,
    }),
  );
  return {
    timeMin,
    timeMax,
    calendars: asRecord(result.calendars),
  };
}

function summarizeCalendar(calendar: Record<string, unknown>) {
  return {
    id: readString(calendar, "id"),
    summary: readString(calendar, "summary"),
    primary: calendar.primary === true,
    accessRole: readString(calendar, "accessRole"),
  };
}

function summarizeEvent(event: Record<string, unknown>) {
  return {
    id: readString(event, "id"),
    status: readString(event, "status"),
    summary: readString(event, "summary"),
    description: truncate(readString(event, "description"), 1_000),
    location: readString(event, "location"),
    htmlLink: readString(event, "htmlLink"),
    start: asRecord(event.start),
    end: asRecord(event.end),
    attendees: asArray(event.attendees)
      .slice(0, 20)
      .map((attendee) => {
        const record = asRecord(attendee);
        return {
          email: readString(record, "email"),
          displayName: readString(record, "displayName"),
          responseStatus: readString(record, "responseStatus"),
        };
      }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireString(record: Record<string, unknown>, key: string) {
  const value = readString(record, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function decodeBase64Url(value: string) {
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function truncate(value: unknown, maxChars: number) {
  if (typeof value !== "string") return undefined;
  return value.length > maxChars ? `${value.slice(0, maxChars).trimEnd()}...` : value;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function displayName(provider: GoatIntegrationProvider) {
  return provider === "gmail" ? "Gmail" : "Google Calendar";
}
