import { buildAad, decryptJson, type EncryptedPayload, encryptJson } from "@opencompany/crypto";
import { getDb } from "@opencompany/db/client";
import {
  workspaceIntegrationCredentials,
  workspaceIntegrationResources,
  workspaceIntegrations,
} from "@opencompany/db/schema";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { HostedToolResult } from "./hosted-tools";

// First-party Gmail (read-only), Google Calendar (read/write), and Google Drive (read/write)
// tools. Each call resolves a connected Google account, decrypts its OAuth tokens, refreshes the
// access token if expired, and talks directly to the Google REST APIs. Credentials are stored by
// the web app in workspace_integration_credentials with the same AES-256-GCM scheme used here.

export type GoogleProviderKey = "gmail" | "google_calendar" | "google_drive";

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
const DRIVE_TOOLS = new Set([
  "drive_search_files",
  "drive_get_file",
  "drive_export_file",
  "drive_create_document",
  "drive_update_document",
  "drive_update_file_metadata",
]);

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DOCS_BASE = "https://docs.googleapis.com/v1";
const ENCRYPTION_KEY_VERSION = 1;
// Refresh a little before the real expiry to absorb clock skew and request latency.
const REFRESH_SKEW_MS = 60_000;
const MAX_MESSAGE_BODY_CHARS = 12_000;
const MAX_DRIVE_TEXT_CHARS = 50_000;
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_WORKSPACE_MIME_PREFIX = "application/vnd.google-apps.";
const DRIVE_FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "description",
  "webViewLink",
  "iconLink",
  "createdTime",
  "modifiedTime",
  "owners(displayName,emailAddress)",
  "lastModifyingUser(displayName,emailAddress)",
  "size",
  "parents",
  "starred",
  "trashed",
  "shared",
].join(",");

export function isGoogleHostedTool(name: string): boolean {
  return GMAIL_TOOLS.has(name) || CALENDAR_TOOLS.has(name) || DRIVE_TOOLS.has(name);
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

  const provider: GoogleProviderKey = GMAIL_TOOLS.has(input.name)
    ? "gmail"
    : CALENDAR_TOOLS.has(input.name)
      ? "google_calendar"
      : "google_drive";
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
      `No ${displayName(provider)} account is connected for this workspace. Connect one in the Integrations tab.`,
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
  options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
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
      `${displayName(account.provider)} credentials are missing. Reconnect the account in the Integrations tab.`,
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
      `${displayName(account.provider)} needs to be reconnected (no refresh token). Reconnect it in the Integrations tab.`,
    );
  }
  return refreshAccessToken(context, account, tokens, options.signal);
}

async function refreshAccessToken(
  context: GoogleToolContext,
  account: ResolvedAccount,
  tokens: StoredGoogleTokens,
  signal?: AbortSignal,
): Promise<string> {
  if (!context.clientId || !context.clientSecret) {
    throw new Error(
      "Google OAuth client is not configured on the runner (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).",
    );
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: signal ?? null,
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
        `${displayName(account.provider)} access was revoked. Reconnect it in the Integrations tab.`,
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

  // A successful refresh clears any prior needs_reauth flag on the connection. Guard against a
  // concurrent user-triggered disconnect: never resurrect a row the user just disconnected.
  await db
    .update(workspaceIntegrations)
    .set({ status: "connected", statusReason: null, updatedAt: now })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, context.workspaceId),
        eq(workspaceIntegrations.provider, account.provider),
        eq(workspaceIntegrations.id, account.integrationId),
        ne(workspaceIntegrations.status, "disconnected"),
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
        // Don't flip a row the user disconnected mid-refresh back into an active state.
        ne(workspaceIntegrations.status, "disconnected"),
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

  let token = await getAccessToken(input.context, input.account, { signal: input.signal });
  let response = await run(token);
  if (response.status === 401) {
    // Token rejected mid-flight (e.g. revoked just now); force one refresh and retry.
    token = await getAccessToken(input.context, input.account, {
      forceRefresh: true,
      signal: input.signal,
    });
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

async function googleTextCall(input: {
  context: GoogleToolContext;
  account: ResolvedAccount;
  method: string;
  url: string;
  accept?: string;
  signal: AbortSignal;
}): Promise<{ text: string; contentType: string | null }> {
  const run = async (token: string) =>
    fetch(input.url, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(input.accept ? { Accept: input.accept } : {}),
      },
      signal: input.signal,
    });

  let token = await getAccessToken(input.context, input.account, { signal: input.signal });
  let response = await run(token);
  if (response.status === 401) {
    token = await getAccessToken(input.context, input.account, {
      forceRefresh: true,
      signal: input.signal,
    });
    response = await run(token);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${displayName(input.account.provider)} API ${input.method} ${pathOf(input.url)} failed with ${response.status}: ${truncate(text, 400)}`,
    );
  }
  return { text, contentType: response.headers.get("content-type") };
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
  const textCall = (method: string, url: string, accept?: string) =>
    googleTextCall({
      context,
      account,
      method,
      url,
      signal,
      ...(accept ? { accept } : {}),
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
    case "drive_search_files":
      return driveSearchFiles({ args, call });
    case "drive_get_file":
      return driveGetFile({ args, call, textCall });
    case "drive_export_file":
      return driveExportFile({ args, call, textCall });
    case "drive_create_document":
      return driveCreateDocument({ args, call });
    case "drive_update_document":
      return driveUpdateDocument({ args, call });
    case "drive_update_file_metadata":
      return driveUpdateFileMetadata({ args, call });
    default:
      throw new Error(`Unknown Google tool: ${name}`);
  }
}

type Caller = (method: string, url: string, body?: unknown) => Promise<unknown>;
type TextCaller = (
  method: string,
  url: string,
  accept?: string,
) => Promise<{ text: string; contentType: string | null }>;

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
  if (Object.keys(body).length === 0) {
    throw new Error(
      "Provide at least one field to change (summary, description, location, start, end, or attendees).",
    );
  }
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

// --- Drive + Docs handlers -------------------------------------------------

async function driveSearchFiles(input: { args: Record<string, unknown>; call: Caller }) {
  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set(
    "pageSize",
    String(clampInt(readNumber(input.args, "maxResults"), 20, 1, 100)),
  );
  url.searchParams.set("fields", `nextPageToken,files(${DRIVE_FILE_FIELDS})`);
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  const query = buildDriveQuery(input.args);
  if (query) url.searchParams.set("q", query);

  const data = asRecord(await input.call("GET", url.toString()));
  return {
    files: asArray(data.files).map((file) => summarizeDriveFile(asRecord(file))),
    nextPageToken: readString(data, "nextPageToken"),
  };
}

async function driveGetFile(input: {
  args: Record<string, unknown>;
  call: Caller;
  textCall: TextCaller;
}) {
  const fileId = requireString(input.args, "fileId");
  const file = await driveGetFileMetadata(fileId, input.call);
  const includeContent = readBoolean(input.args, "includeContent") !== false;
  if (!includeContent) return { file };

  return {
    file,
    content: await driveReadFileContent({
      file,
      requestedMimeType: readString(input.args, "mimeType"),
      textCall: input.textCall,
    }),
  };
}

async function driveExportFile(input: {
  args: Record<string, unknown>;
  call: Caller;
  textCall: TextCaller;
}) {
  const fileId = requireString(input.args, "fileId");
  const file = await driveGetFileMetadata(fileId, input.call);
  return {
    file,
    content: await driveReadFileContent({
      file,
      requestedMimeType: readString(input.args, "mimeType"),
      textCall: input.textCall,
    }),
  };
}

async function driveCreateDocument(input: { args: Record<string, unknown>; call: Caller }) {
  const title = requireString(input.args, "title");
  const folderId = readString(input.args, "folderId");
  const metadata: Record<string, unknown> = {
    name: title,
    mimeType: GOOGLE_DOC_MIME_TYPE,
  };
  if (folderId) metadata.parents = [folderId];

  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set("fields", DRIVE_FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  const file = summarizeDriveFile(asRecord(await input.call("POST", url.toString(), metadata)));
  if (!file.id) {
    throw new Error("Google Drive did not return an id for the created document.");
  }

  const text = readString(input.args, "text");
  if (text) {
    await docsBatchUpdate(input.call, file.id, [{ insertText: { location: { index: 1 }, text } }]);
  }

  return { file, documentId: file.id, webViewLink: file.webViewLink };
}

async function driveUpdateDocument(input: { args: Record<string, unknown>; call: Caller }) {
  const documentId = requireString(input.args, "documentId");
  const operation = requireString(input.args, "operation");
  const requiredRevisionId = readString(input.args, "requiredRevisionId");
  const requests = await buildDocsUpdateRequests(input.call, documentId, operation, input.args);

  const result = await docsBatchUpdate(input.call, documentId, requests, requiredRevisionId);
  return {
    documentId,
    operation,
    replies: asArray(result.replies),
    writeControl: asRecord(result.writeControl),
  };
}

async function driveUpdateFileMetadata(input: { args: Record<string, unknown>; call: Caller }) {
  const fileId = requireString(input.args, "fileId");
  const name = readString(input.args, "name");
  const starred = readBoolean(input.args, "starred");
  const addParentFolderId = readString(input.args, "addParentFolderId");
  const removeParentFolderId = readString(input.args, "removeParentFolderId");
  const body: Record<string, unknown> = {};

  if (name !== undefined) body.name = name;
  if (starred !== undefined) body.starred = starred;

  if (Object.keys(body).length === 0 && !addParentFolderId && !removeParentFolderId) {
    throw new Error(
      "Provide at least one metadata change (name, starred, addParentFolderId, or removeParentFolderId).",
    );
  }

  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", DRIVE_FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  if (addParentFolderId) url.searchParams.set("addParents", addParentFolderId);
  if (removeParentFolderId) url.searchParams.set("removeParents", removeParentFolderId);

  return { file: summarizeDriveFile(asRecord(await input.call("PATCH", url.toString(), body))) };
}

async function driveGetFileMetadata(fileId: string, call: Caller) {
  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", DRIVE_FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  return summarizeDriveFile(asRecord(await call("GET", url.toString())));
}

async function driveReadFileContent(input: {
  file: ReturnType<typeof summarizeDriveFile>;
  requestedMimeType: string | undefined;
  textCall: TextCaller;
}) {
  const exportMimeType = input.requestedMimeType ?? defaultDriveExportMimeType(input.file.mimeType);

  if (isGoogleWorkspaceMimeType(input.file.mimeType)) {
    if (!exportMimeType) {
      throw new Error(`Google Drive file ${input.file.id} cannot be exported as text.`);
    }
    const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(input.file.id)}/export`);
    url.searchParams.set("mimeType", exportMimeType);
    const { text, contentType } = await input.textCall("GET", url.toString(), exportMimeType);
    return textContentResult("export", exportMimeType, contentType, text);
  }

  if (!isTextLikeMimeType(input.file.mimeType)) {
    throw new Error(
      `Drive file ${input.file.id} has MIME type ${input.file.mimeType ?? "unknown"} and is not a text-like file. Native Google Docs can be exported; binary files are not supported in this v1 tool.`,
    );
  }

  const url = new URL(`${DRIVE_BASE}/files/${encodeURIComponent(input.file.id)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const { text, contentType } = await input.textCall(
    "GET",
    url.toString(),
    exportMimeType ?? input.file.mimeType ?? "text/plain",
  );
  return textContentResult("download", input.file.mimeType, contentType, text);
}

async function docsBatchUpdate(
  call: Caller,
  documentId: string,
  requests: unknown[],
  requiredRevisionId?: string,
) {
  const body: Record<string, unknown> = { requests };
  if (requiredRevisionId) body.writeControl = { requiredRevisionId };
  return asRecord(
    await call(
      "POST",
      `${DOCS_BASE}/documents/${encodeURIComponent(documentId)}:batchUpdate`,
      body,
    ),
  );
}

async function buildDocsUpdateRequests(
  call: Caller,
  documentId: string,
  operation: string,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  switch (operation) {
    case "append_text": {
      const text = requireString(args, "text");
      const endIndex = await docsEndIndex(call, documentId);
      return [{ insertText: { location: { index: Math.max(1, endIndex - 1) }, text } }];
    }
    case "replace_all_text": {
      const matchText = requireString(args, "matchText");
      const text = requireString(args, "text");
      return [
        {
          replaceAllText: {
            containsText: { text: matchText, matchCase: false },
            replaceText: text,
          },
        },
      ];
    }
    case "insert_text": {
      const text = requireString(args, "text");
      const startIndex = requireInteger(args, "startIndex");
      return [{ insertText: { location: { index: startIndex }, text } }];
    }
    case "delete_range": {
      const startIndex = requireInteger(args, "startIndex");
      const endIndex = requireInteger(args, "endIndex");
      if (endIndex <= startIndex) {
        throw new Error("endIndex must be greater than startIndex.");
      }
      return [{ deleteContentRange: { range: { startIndex, endIndex } } }];
    }
    default:
      throw new Error(
        "operation must be one of append_text, replace_all_text, insert_text, or delete_range.",
      );
  }
}

async function docsEndIndex(call: Caller, documentId: string): Promise<number> {
  const url = new URL(`${DOCS_BASE}/documents/${encodeURIComponent(documentId)}`);
  url.searchParams.set("fields", "body/content/endIndex");
  const document = asRecord(await call("GET", url.toString()));
  const content = asArray(asRecord(document.body).content);
  const indexes = content
    .map((entry) => readNumber(asRecord(entry), "endIndex"))
    .filter((index): index is number => typeof index === "number" && Number.isFinite(index));
  return indexes.length > 0 ? Math.max(...indexes) : 1;
}

function buildDriveQuery(args: Record<string, unknown>) {
  const terms: string[] = [];
  const query = readString(args, "query")?.trim();
  const driveQuery = readString(args, "driveQuery")?.trim();
  const mimeType = readString(args, "mimeType");
  const folderId = readString(args, "folderId");
  const modifiedAfter = readString(args, "modifiedAfter");
  const starred = readBoolean(args, "starred");
  const sharedWithMe = readBoolean(args, "sharedWithMe");
  const includeTrashed = readBoolean(args, "includeTrashed") === true;

  if (driveQuery) terms.push(`(${driveQuery})`);
  if (query) {
    const literal = driveQueryLiteral(query);
    terms.push(`(name contains '${literal}' or fullText contains '${literal}')`);
  }
  if (mimeType) terms.push(`mimeType = '${driveQueryLiteral(mimeType)}'`);
  if (folderId) terms.push(`'${driveQueryLiteral(folderId)}' in parents`);
  if (modifiedAfter) terms.push(`modifiedTime > '${driveQueryLiteral(modifiedAfter)}'`);
  if (starred !== undefined) terms.push(`starred = ${starred ? "true" : "false"}`);
  if (sharedWithMe === true) terms.push("sharedWithMe = true");
  if (!includeTrashed) terms.push("trashed = false");

  return terms.join(" and ");
}

function summarizeDriveFile(file: Record<string, unknown>) {
  return {
    id: readString(file, "id") ?? "",
    name: readString(file, "name") ?? "",
    mimeType: readString(file, "mimeType"),
    description: readString(file, "description"),
    webViewLink: readString(file, "webViewLink"),
    iconLink: readString(file, "iconLink"),
    createdTime: readString(file, "createdTime"),
    modifiedTime: readString(file, "modifiedTime"),
    owners: asArray(file.owners).map((owner) => summarizeGooglePerson(asRecord(owner))),
    lastModifyingUser: summarizeGooglePerson(asRecord(file.lastModifyingUser)),
    size: readString(file, "size"),
    parents: asArray(file.parents).filter((parent): parent is string => typeof parent === "string"),
    starred: readBoolean(file, "starred") ?? false,
    trashed: readBoolean(file, "trashed") ?? false,
    shared: readBoolean(file, "shared") ?? false,
  };
}

function summarizeGooglePerson(value: Record<string, unknown>) {
  return {
    displayName: readString(value, "displayName"),
    emailAddress: readString(value, "emailAddress"),
  };
}

function textContentResult(
  source: "export" | "download",
  mimeType: string | undefined,
  contentType: string | null,
  text: string,
) {
  return {
    source,
    mimeType,
    contentType,
    text: truncate(text, MAX_DRIVE_TEXT_CHARS),
    truncated: text.length > MAX_DRIVE_TEXT_CHARS,
  };
}

function defaultDriveExportMimeType(mimeType: string | undefined) {
  if (mimeType === GOOGLE_DOC_MIME_TYPE) return "text/plain";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "text/csv";
  if (mimeType === "application/vnd.google-apps.presentation") return "text/plain";
  return undefined;
}

function isGoogleWorkspaceMimeType(mimeType: string | undefined) {
  return Boolean(mimeType?.startsWith(GOOGLE_WORKSPACE_MIME_PREFIX));
}

function isTextLikeMimeType(mimeType: string | undefined) {
  if (!mimeType) return false;
  if (mimeType.startsWith("text/")) return true;
  return [
    "application/json",
    "application/xml",
    "application/csv",
    "application/x-ndjson",
    "application/rtf",
    "application/vnd.oasis.opendocument.text",
  ].includes(mimeType);
}

function driveQueryLiteral(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
    `Calendar "${calendarId}" is not enabled for agents on ${account.accountEmail ?? "this account"}. Enable it in the Integrations tab.`,
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
  // Google rejects events that carry both a timed (dateTime) and an all-day (date) value; reject it
  // up front with a clear message instead of surfacing an opaque API 400.
  if (result.dateTime && result.date) {
    throw new Error("Event time must use either dateTime (timed) or date (all-day), not both.");
  }
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
  if (provider === "gmail") return "Gmail";
  if (provider === "google_calendar") return "Google Calendar";
  return "Google Drive";
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

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireInteger(record: Record<string, unknown>, key: string): number {
  const value = readNumber(record, key);
  if (value === undefined || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`);
  }
  return value;
}
