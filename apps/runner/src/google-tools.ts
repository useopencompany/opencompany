import { buildAad, decryptJson, type EncryptedPayload, encryptJson } from "@opencompany/crypto";
import { getDb } from "@opencompany/db/client";
import {
  workspaceIntegrationCredentials,
  workspaceIntegrationResources,
  workspaceIntegrations,
} from "@opencompany/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import type { HostedToolResult } from "./hosted-tools";

// First-party Gmail (read-only) and Google Calendar (read/write) tools. Each call resolves a
// connected Google account, decrypts its OAuth tokens, refreshes the access token if expired,
// and talks directly to the Google REST APIs. Credentials are stored by the web app in
// workspace_integration_credentials with the same AES-256-GCM scheme used here.

export type GoogleProviderKey = "gmail" | "google_calendar";

export type GoogleToolContext = {
  workspaceId: string;
  encryptionKey: Buffer;
  clientId: string | undefined;
  clientSecret: string | undefined;
};

const GMAIL_TOOLS = new Set([
  "gmail_list_messages",
  "gmail_get_message",
  "gmail_search",
  "gmail_list_threads",
  "gmail_get_thread",
  "gmail_list_labels",
]);
const CALENDAR_TOOLS = new Set([
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_get_event",
  "calendar_get_freebusy",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
]);

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const ENCRYPTION_KEY_VERSION = 1;
// Refresh a little before the real expiry to absorb clock skew and request latency.
const REFRESH_SKEW_MS = 60_000;
const MAX_MESSAGE_BODY_CHARS = 12_000;

export function isGoogleHostedTool(name: string): boolean {
  return GMAIL_TOOLS.has(name) || CALENDAR_TOOLS.has(name);
}

export async function executeGoogleHostedTool(input: {
  name: string;
  args: unknown;
  context: GoogleToolContext | undefined;
  signal: AbortSignal;
}): Promise<HostedToolResult> {
  const { context } = input;
  if (!context) {
    throw new Error("Google tools require a workspace context and are not available in this run.");
  }

  const provider: GoogleProviderKey = GMAIL_TOOLS.has(input.name) ? "gmail" : "google_calendar";
  const args = asRecord(input.args);
  const account = await resolveAccount(context, provider, readString(args, "account"));

  const output = await dispatchGoogleTool({
    name: input.name,
    args,
    context,
    account,
    signal: input.signal,
  });
  return { output };
}

// --- account + token resolution -------------------------------------------

type ResolvedAccount = {
  integrationId: string;
  provider: GoogleProviderKey;
  accountEmail: string | null;
};

async function resolveAccount(
  context: GoogleToolContext,
  provider: GoogleProviderKey,
  accountArg: string | undefined,
): Promise<ResolvedAccount> {
  const rows = await getDb()
    .select({
      id: workspaceIntegrations.id,
      accountEmail: workspaceIntegrations.accountEmail,
      status: workspaceIntegrations.status,
    })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, context.workspaceId),
        eq(workspaceIntegrations.provider, provider),
      ),
    );

  const active = rows.filter((row) => row.status !== "disconnected");
  if (active.length === 0) {
    throw new Error(
      `No ${displayName(provider)} account is connected for this workspace. Connect one in Settings → Integrations.`,
    );
  }

  if (accountArg) {
    const wanted = accountArg.trim().toLowerCase();
    const match = active.find((row) => (row.accountEmail ?? "").toLowerCase() === wanted);
    if (!match) {
      throw new Error(
        `No connected ${displayName(provider)} account matches "${accountArg}". Connected: ${connectedList(active)}.`,
      );
    }
    return { integrationId: match.id, provider, accountEmail: match.accountEmail };
  }

  if (active.length > 1) {
    throw new Error(
      `Multiple ${displayName(provider)} accounts are connected; pass "account" to choose one. Connected: ${connectedList(active)}.`,
    );
  }

  const only = active[0]!;
  return { integrationId: only.id, provider, accountEmail: only.accountEmail };
}

type StoredGoogleTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

async function getAccessToken(
  context: GoogleToolContext,
  account: ResolvedAccount,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({
      encryptedPayload: workspaceIntegrationCredentials.encryptedPayload,
      encryptionKeyVersion: workspaceIntegrationCredentials.encryptionKeyVersion,
      expiresAt: workspaceIntegrationCredentials.expiresAt,
    })
    .from(workspaceIntegrationCredentials)
    .where(
      and(
        eq(workspaceIntegrationCredentials.workspaceId, context.workspaceId),
        eq(workspaceIntegrationCredentials.integrationId, account.integrationId),
        eq(workspaceIntegrationCredentials.provider, account.provider),
        eq(workspaceIntegrationCredentials.kind, "oauth_token"),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error(
      `${displayName(account.provider)} credentials are missing. Reconnect the account in Settings → Integrations.`,
    );
  }

  const tokens = decryptTokens(row.encryptedPayload, {
    context,
    account,
    keyVersion: row.encryptionKeyVersion,
  });

  const expired = row.expiresAt ? row.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now() : true;
  if (!options.forceRefresh && !expired && tokens.access_token) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    await markNeedsReauth(context, account, "Stored Google credentials have no refresh token.");
    throw new Error(
      `${displayName(account.provider)} needs to be reconnected (no refresh token). Reconnect it in Settings → Integrations.`,
    );
  }
  return refreshAccessToken(context, account, tokens);
}

async function refreshAccessToken(
  context: GoogleToolContext,
  account: ResolvedAccount,
  tokens: StoredGoogleTokens,
): Promise<string> {
  if (!context.clientId || !context.clientSecret) {
    throw new Error(
      "Google OAuth client is not configured on the runner (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).",
    );
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: context.clientId,
      client_secret: context.clientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    // invalid_grant means the refresh token was revoked or expired — the user must reconnect.
    if (response.status === 400 && detail.includes("invalid_grant")) {
      await markNeedsReauth(context, account, "Google refused the refresh token (invalid_grant).");
      throw new Error(
        `${displayName(account.provider)} access was revoked. Reconnect it in Settings → Integrations.`,
      );
    }
    throw new Error(`Google token refresh failed with ${response.status}: ${detail}`);
  }

  const result = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
  };
  if (!result.access_token) {
    throw new Error("Google token refresh did not return an access token.");
  }

  // Google usually omits refresh_token on refresh; keep the existing one. Build with
  // conditional spreads so undefined fields are absent (exactOptionalPropertyTypes).
  const refreshToken = result.refresh_token ?? tokens.refresh_token;
  const scope = result.scope ?? tokens.scope;
  const tokenType = result.token_type ?? tokens.token_type;
  const nextTokens: StoredGoogleTokens = {
    access_token: result.access_token,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(scope ? { scope } : {}),
    ...(tokenType ? { token_type: tokenType } : {}),
  };
  const expiresAt =
    typeof result.expires_in === "number" ? new Date(Date.now() + result.expires_in * 1000) : null;

  await persistRefreshedTokens(context, account, nextTokens, expiresAt);
  return result.access_token;
}

async function persistRefreshedTokens(
  context: GoogleToolContext,
  account: ResolvedAccount,
  tokens: StoredGoogleTokens,
  expiresAt: Date | null,
) {
  const now = new Date();
  const encryptedPayload = encryptJson(stripUndefined(tokens), {
    key: context.encryptionKey,
    aad: credentialAad(context, account, ENCRYPTION_KEY_VERSION),
  });

  const db = getDb();
  await db
    .update(workspaceIntegrationCredentials)
    .set({
      encryptedPayload,
      encryptionKeyVersion: ENCRYPTION_KEY_VERSION,
      expiresAt,
      lastRotatedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceIntegrationCredentials.workspaceId, context.workspaceId),
        eq(workspaceIntegrationCredentials.integrationId, account.integrationId),
        eq(workspaceIntegrationCredentials.provider, account.provider),
        eq(workspaceIntegrationCredentials.kind, "oauth_token"),
      ),
    );

  // A successful refresh clears any prior needs_reauth flag on the connection.
  await db
    .update(workspaceIntegrations)
    .set({ status: "connected", statusReason: null, updatedAt: now })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, context.workspaceId),
        eq(workspaceIntegrations.provider, account.provider),
        eq(workspaceIntegrations.id, account.integrationId),
      ),
    );
}

async function markNeedsReauth(
  context: GoogleToolContext,
  account: ResolvedAccount,
  reason: string,
) {
  await getDb()
    .update(workspaceIntegrations)
    .set({ status: "needs_reauth", statusReason: reason.slice(0, 240), updatedAt: new Date() })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, context.workspaceId),
        eq(workspaceIntegrations.provider, account.provider),
        eq(workspaceIntegrations.id, account.integrationId),
      ),
    );
}

function decryptTokens(
  encryptedPayload: EncryptedPayload,
  input: { context: GoogleToolContext; account: ResolvedAccount; keyVersion: number },
): StoredGoogleTokens {
  try {
    return decryptJson(encryptedPayload, {
      key: input.context.encryptionKey,
      aad: credentialAad(input.context, input.account, input.keyVersion),
    }) as StoredGoogleTokens;
  } catch {
    throw new Error(
      `Could not decrypt ${displayName(input.account.provider)} credentials. Reconnect the account.`,
    );
  }
}

function credentialAad(context: GoogleToolContext, account: ResolvedAccount, keyVersion: number) {
  return googleCredentialAad({
    workspaceId: context.workspaceId,
    integrationId: account.integrationId,
    provider: account.provider,
    keyVersion,
  });
}

// Field order MUST match the web app's credential-storage `authenticatedData` exactly, or the
// runner cannot decrypt what the web encrypted. Exported so a test can pin the contract.
export function googleCredentialAad(input: {
  workspaceId: string;
  integrationId: string;
  provider: GoogleProviderKey;
  keyVersion: number;
}) {
  return buildAad({
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    provider: input.provider,
    kind: "oauth_token",
    keyVersion: input.keyVersion,
  });
}

// --- Google REST helpers ---------------------------------------------------

async function googleApiCall(input: {
  context: GoogleToolContext;
  account: ResolvedAccount;
  method: string;
  url: string;
  body?: unknown;
  signal: AbortSignal;
}): Promise<unknown> {
  const run = async (token: string) => {
    const init: RequestInit = {
      method: input.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal: input.signal,
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    };
    return fetch(input.url, init);
  };

  let token = await getAccessToken(input.context, input.account);
  let response = await run(token);
  if (response.status === 401) {
    // Token rejected mid-flight (e.g. revoked just now); force one refresh and retry.
    token = await getAccessToken(input.context, input.account, { forceRefresh: true });
    response = await run(token);
  }

  if (response.status === 204) return {};
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${displayName(input.account.provider)} API ${input.method} ${pathOf(input.url)} failed with ${response.status}: ${truncate(text, 400)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

// --- tool dispatch ---------------------------------------------------------

async function dispatchGoogleTool(input: {
  name: string;
  args: Record<string, unknown>;
  context: GoogleToolContext;
  account: ResolvedAccount;
  signal: AbortSignal;
}): Promise<unknown> {
  const { name, args, context, account, signal } = input;
  const call = (method: string, url: string, body?: unknown) =>
    googleApiCall({
      context,
      account,
      method,
      url,
      signal,
      ...(body !== undefined ? { body } : {}),
    });

  switch (name) {
    case "gmail_list_messages":
    case "gmail_search":
      return gmailListMessages({ args, call, requireQuery: name === "gmail_search" });
    case "gmail_get_message":
      return gmailGetMessage({ args, call });
    case "gmail_list_threads":
      return gmailListThreads({ args, call });
    case "gmail_get_thread":
      return gmailGetThread({ args, call });
    case "gmail_list_labels":
      return call("GET", `${GMAIL_BASE}/labels`).then((data) => ({
        labels: asArray(asRecord(data).labels).map((label) => {
          const record = asRecord(label);
          return {
            id: readString(record, "id"),
            name: readString(record, "name"),
            type: readString(record, "type"),
          };
        }),
      }));
    case "calendar_list_calendars":
      return calendarListCalendars(context, account);
    case "calendar_list_events":
      return calendarListEvents({ args, call, context, account });
    case "calendar_get_event":
      return calendarGetEvent({ args, call, context, account });
    case "calendar_get_freebusy":
      return calendarFreeBusy({ args, call, context, account });
    case "calendar_create_event":
      return calendarCreateEvent({ args, call, context, account });
    case "calendar_update_event":
      return calendarUpdateEvent({ args, call, context, account });
    case "calendar_delete_event":
      return calendarDeleteEvent({ args, call, context, account });
    default:
      throw new Error(`Unknown Google tool: ${name}`);
  }
}

type Caller = (method: string, url: string, body?: unknown) => Promise<unknown>;

async function gmailListMessages(input: {
  args: Record<string, unknown>;
  call: Caller;
  requireQuery: boolean;
}) {
  const query = readString(input.args, "query");
  if (input.requireQuery && !query) {
    throw new Error("gmail_search requires a non-empty query.");
  }
  const maxResults = clampInt(readNumber(input.args, "maxResults"), 20, 1, 100);
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
  const format = readString(input.args, "format") === "metadata" ? "metadata" : "full";
  const url = new URL(`${GMAIL_BASE}/messages/${messageId}`);
  url.searchParams.set("format", format);
  if (format === "metadata") {
    for (const header of ["From", "To", "Cc", "Subject", "Date"]) {
      url.searchParams.append("metadataHeaders", header);
    }
  }
  const message = asRecord(await input.call("GET", url.toString()));
  return parseFullMessage(message, format === "full");
}

async function gmailListThreads(input: { args: Record<string, unknown>; call: Caller }) {
  const query = readString(input.args, "query");
  const maxResults = clampInt(readNumber(input.args, "maxResults"), 20, 1, 100);
  const url = new URL(`${GMAIL_BASE}/threads`);
  url.searchParams.set("maxResults", String(maxResults));
  if (query) url.searchParams.set("q", query);
  const data = asRecord(await input.call("GET", url.toString()));
  return {
    threads: asArray(data.threads).map((thread) => {
      const record = asRecord(thread);
      return {
        id: readString(record, "id"),
        snippet: readString(record, "snippet"),
        historyId: readString(record, "historyId"),
      };
    }),
  };
}

async function gmailGetThread(input: { args: Record<string, unknown>; call: Caller }) {
  const threadId = requireString(input.args, "threadId");
  const url = new URL(`${GMAIL_BASE}/threads/${threadId}`);
  url.searchParams.set("format", "full");
  const data = asRecord(await input.call("GET", url.toString()));
  return {
    id: readString(data, "id"),
    messages: asArray(data.messages).map((message) => parseFullMessage(asRecord(message), true)),
  };
}

// --- calendar handlers -----------------------------------------------------

async function calendarListCalendars(context: GoogleToolContext, account: ResolvedAccount) {
  const calendars = await loadSelectedCalendars(context, account.integrationId);
  return {
    calendars: calendars.map((calendar) => ({
      id: calendar.externalId,
      name: calendar.name,
      primary: calendar.primary,
    })),
  };
}

async function calendarListEvents(input: {
  args: Record<string, unknown>;
  call: Caller;
  context: GoogleToolContext;
  account: ResolvedAccount;
}) {
  const calendarId = await requireSelectedCalendar(input);
  const url = new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set(
    "maxResults",
    String(clampInt(readNumber(input.args, "maxResults"), 25, 1, 250)),
  );
  const timeMin = readString(input.args, "timeMin");
  const timeMax = readString(input.args, "timeMax");
  const query = readString(input.args, "query");
  if (timeMin) url.searchParams.set("timeMin", timeMin);
  if (timeMax) url.searchParams.set("timeMax", timeMax);
  if (query) url.searchParams.set("q", query);

  const data = asRecord(await input.call("GET", url.toString()));
  return {
    calendarId,
    events: asArray(data.items).map((event) => summarizeEvent(asRecord(event))),
  };
}

async function calendarGetEvent(input: {
  args: Record<string, unknown>;
  call: Caller;
  context: GoogleToolContext;
  account: ResolvedAccount;
}) {
  const calendarId = await requireSelectedCalendar(input);
  const eventId = requireString(input.args, "eventId");
  const data = await input.call(
    "GET",
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
  return summarizeEvent(asRecord(data));
}

async function calendarFreeBusy(input: {
  args: Record<string, unknown>;
  call: Caller;
  context: GoogleToolContext;
  account: ResolvedAccount;
}) {
  const timeMin = requireString(input.args, "timeMin");
  const timeMax = requireString(input.args, "timeMax");
  const requested = asArray(input.args.calendarIds)
    .filter((id): id is string => typeof id === "string")
    .map((id) => id);
  const calendarIds = requested.length > 0 ? requested : ["primary"];

  const selected = await loadSelectedCalendarIds(input.context, input.account.integrationId);
  for (const id of calendarIds) {
    assertCalendarAllowed(id, selected, input.account);
  }

  const data = asRecord(
    await input.call("POST", `${CALENDAR_BASE}/freeBusy`, {
      timeMin,
      timeMax,
      items: calendarIds.map((id) => ({ id })),
    }),
  );
  const calendars = asRecord(data.calendars);
  return {
    calendars: Object.fromEntries(
      Object.entries(calendars).map(([id, value]) => [id, { busy: asArray(asRecord(value).busy) }]),
    ),
  };
}

async function calendarCreateEvent(input: {
  args: Record<string, unknown>;
  call: Caller;
  context: GoogleToolContext;
  account: ResolvedAccount;
}) {
  const calendarId = await requireSelectedCalendar(input);
  const url = new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  applySendUpdates(url, input.args);
  const body = buildEventBody(input.args, { requireTimes: true });
  const data = await input.call("POST", url.toString(), body);
  return summarizeEvent(asRecord(data));
}

async function calendarUpdateEvent(input: {
  args: Record<string, unknown>;
  call: Caller;
  context: GoogleToolContext;
  account: ResolvedAccount;
}) {
  const calendarId = await requireSelectedCalendar(input);
  const eventId = requireString(input.args, "eventId");
  const url = new URL(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
  applySendUpdates(url, input.args);
  const body = buildEventBody(input.args, { requireTimes: false });
  const data = await input.call("PATCH", url.toString(), body);
  return summarizeEvent(asRecord(data));
}

async function calendarDeleteEvent(input: {
  args: Record<string, unknown>;
  call: Caller;
  context: GoogleToolContext;
  account: ResolvedAccount;
}) {
  const calendarId = await requireSelectedCalendar(input);
  const eventId = requireString(input.args, "eventId");
  const url = new URL(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
  applySendUpdates(url, input.args);
  await input.call("DELETE", url.toString());
  return { deleted: true, eventId, calendarId };
}

// --- calendar selection enforcement ---------------------------------------

type SelectedCalendar = { externalId: string; name: string; primary: boolean };

async function loadSelectedCalendars(
  context: GoogleToolContext,
  integrationId: string,
): Promise<SelectedCalendar[]> {
  const rows = await getDb()
    .select({
      externalId: workspaceIntegrationResources.externalId,
      name: workspaceIntegrationResources.name,
      metadata: workspaceIntegrationResources.metadata,
    })
    .from(workspaceIntegrationResources)
    .where(
      and(
        eq(workspaceIntegrationResources.workspaceId, context.workspaceId),
        eq(workspaceIntegrationResources.integrationId, integrationId),
        eq(workspaceIntegrationResources.provider, "google_calendar"),
        eq(workspaceIntegrationResources.resourceType, "calendar"),
        eq(workspaceIntegrationResources.status, "available"),
        isNotNull(workspaceIntegrationResources.selectedAt),
      ),
    );
  return rows.map((row) => ({
    externalId: row.externalId,
    name: row.name,
    primary: row.metadata.primary === true,
  }));
}

async function loadSelectedCalendarIds(
  context: GoogleToolContext,
  integrationId: string,
): Promise<Set<string>> {
  const calendars = await loadSelectedCalendars(context, integrationId);
  const ids = new Set(calendars.map((calendar) => calendar.externalId));
  // "primary" is always addressable: it is the account owner's own calendar and is
  // auto-selected on connect.
  ids.add("primary");
  for (const calendar of calendars) {
    if (calendar.primary) ids.add("primary");
  }
  return ids;
}

async function requireSelectedCalendar(input: {
  args: Record<string, unknown>;
  context: GoogleToolContext;
  account: ResolvedAccount;
}): Promise<string> {
  const calendarId = readString(input.args, "calendarId") || "primary";
  const selected = await loadSelectedCalendarIds(input.context, input.account.integrationId);
  assertCalendarAllowed(calendarId, selected, input.account);
  return calendarId;
}

function assertCalendarAllowed(
  calendarId: string,
  selected: Set<string>,
  account: ResolvedAccount,
) {
  if (calendarId === "primary" || selected.has(calendarId)) return;
  throw new Error(
    `Calendar "${calendarId}" is not enabled for agents on ${account.accountEmail ?? "this account"}. Enable it in Settings → Integrations.`,
  );
}

// --- normalizers -----------------------------------------------------------

function buildEventBody(args: Record<string, unknown>, options: { requireTimes: boolean }) {
  const body: Record<string, unknown> = {};
  const summary = readString(args, "summary");
  const description = readString(args, "description");
  const location = readString(args, "location");
  if (summary !== undefined) body.summary = summary;
  if (description !== undefined) body.description = description;
  if (location !== undefined) body.location = location;

  const start = readEventTime(args.start);
  const end = readEventTime(args.end);
  if (options.requireTimes && (!start || !end)) {
    throw new Error("start and end are required (each with dateTime or date).");
  }
  if (start) body.start = start;
  if (end) body.end = end;

  const attendees = asArray(args.attendees)
    .filter((email): email is string => typeof email === "string")
    .map((email) => ({ email }));
  if (attendees.length > 0) body.attendees = attendees;

  return body;
}

function readEventTime(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  if (typeof value.dateTime === "string") result.dateTime = value.dateTime;
  if (typeof value.date === "string") result.date = value.date;
  if (typeof value.timeZone === "string") result.timeZone = value.timeZone;
  return result.dateTime || result.date ? result : null;
}

function applySendUpdates(url: URL, args: Record<string, unknown>) {
  const sendUpdates = readString(args, "sendUpdates");
  url.searchParams.set(
    "sendUpdates",
    sendUpdates === "all" || sendUpdates === "externalOnly" ? sendUpdates : "none",
  );
}

function summarizeEvent(event: Record<string, unknown>) {
  return {
    id: readString(event, "id"),
    status: readString(event, "status"),
    summary: readString(event, "summary"),
    description: readString(event, "description"),
    location: readString(event, "location"),
    start: event.start,
    end: event.end,
    htmlLink: readString(event, "htmlLink"),
    organizer: event.organizer,
    attendees: asArray(event.attendees),
  };
}

function summarizeMessage(message: Record<string, unknown>) {
  const headers = headerMap(message);
  return {
    id: readString(message, "id"),
    threadId: readString(message, "threadId"),
    snippet: readString(message, "snippet"),
    from: headers.from,
    to: headers.to,
    subject: headers.subject,
    date: headers.date,
  };
}

function parseFullMessage(message: Record<string, unknown>, includeBody: boolean) {
  const headers = headerMap(message);
  const base = {
    id: readString(message, "id"),
    threadId: readString(message, "threadId"),
    snippet: readString(message, "snippet"),
    labelIds: asArray(message.labelIds).filter((id): id is string => typeof id === "string"),
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    subject: headers.subject,
    date: headers.date,
  };
  if (!includeBody) return base;
  const body = extractMessageBody(asRecord(message.payload));
  return { ...base, body: truncate(body, MAX_MESSAGE_BODY_CHARS) };
}

function headerMap(message: Record<string, unknown>) {
  const payload = asRecord(message.payload);
  const out: Record<string, string> = {};
  for (const header of asArray(payload.headers)) {
    const record = asRecord(header);
    const name = readString(record, "name")?.toLowerCase();
    const value = readString(record, "value");
    if (name && value) out[name] = value;
  }
  return {
    from: out.from,
    to: out.to,
    cc: out.cc,
    subject: out.subject,
    date: out.date,
  };
}

function extractMessageBody(payload: Record<string, unknown>): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeBase64Url(plain);
  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodeBase64Url(html));
  const direct = asRecord(payload.body).data;
  if (typeof direct === "string") return decodeBase64Url(direct);
  return "";
}

function findPart(payload: Record<string, unknown>, mimeType: string): string | null {
  if (readString(payload, "mimeType") === mimeType) {
    const data = asRecord(payload.body).data;
    if (typeof data === "string") return data;
  }
  for (const part of asArray(payload.parts)) {
    const found = findPart(asRecord(part), mimeType);
    if (found) return found;
  }
  return null;
}

// --- small utilities -------------------------------------------------------

function displayName(provider: GoogleProviderKey) {
  return provider === "gmail" ? "Gmail" : "Google Calendar";
}

function connectedList(rows: Array<{ accountEmail: string | null }>) {
  return rows.map((row) => row.accountEmail ?? "(unknown email)").join(", ");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
