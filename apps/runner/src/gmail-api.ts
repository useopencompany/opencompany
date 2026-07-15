import { GoogleApiRequestError } from "./google-api-auth";

// Gmail REST helpers for the ingestion workers (poll + flush). The agent tool
// surface in goat-google-tools has its own parsing tuned for tool output; the
// shapes here are tuned for the thread-window normalizer (directions, ISO
// dates, quoted-reply stripping).

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_BODY_CHARS = 12_000;

export type GmailApiCaller = (method: string, url: string) => Promise<unknown>;

export type GmailProfile = {
  emailAddress: string | null;
  historyId: string | null;
};

export type GmailHistoryMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
};

export type GmailHistoryResult = {
  messages: GmailHistoryMessage[];
  latestHistoryId: string | null;
  /** True when Gmail no longer retains the start cursor (404); the caller must
   * reset from the current profile historyId and accept the gap. */
  expired: boolean;
};

export type GmailMessageMetadata = {
  id: string;
  threadId: string;
  labelIds: string[];
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  // RFC822 Message-ID header — the cross-mailbox identity used for
  // cross-member brain dedup.
  rfc822MessageId: string | null;
  snippet: string | null;
  internalDate: Date | null;
};

export type GmailSnapshotMessage = {
  id: string;
  labelIds: string[];
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  snippet: string | null;
  internalDate: Date | null;
  bodyText: string;
};

export type GmailThreadSnapshot = {
  threadId: string;
  messages: GmailSnapshotMessage[];
};

export async function fetchGmailProfile(call: GmailApiCaller): Promise<GmailProfile> {
  const profile = asRecord(await call("GET", `${GMAIL_BASE}/profile`));
  return {
    emailAddress: readString(profile, "emailAddress") ?? null,
    historyId: readString(profile, "historyId") ?? null,
  };
}

export async function listGmailHistoryMessagesAdded(
  call: GmailApiCaller,
  startHistoryId: string,
): Promise<GmailHistoryResult> {
  const messages = new Map<string, GmailHistoryMessage>();
  let latestHistoryId: string | null = null;
  let pageToken: string | null = null;

  do {
    const url = new URL(`${GMAIL_BASE}/history`);
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("historyTypes", "messageAdded");
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let page: Record<string, unknown>;
    try {
      page = asRecord(await call("GET", url.toString()));
    } catch (error) {
      if (error instanceof GoogleApiRequestError && error.status === 404) {
        return { messages: [], latestHistoryId: null, expired: true };
      }
      throw error;
    }

    latestHistoryId = readString(page, "historyId") ?? latestHistoryId;
    for (const entry of asArray(page.history)) {
      const record = asRecord(entry);
      for (const added of asArray(record.messagesAdded)) {
        const message = asRecord(asRecord(added).message);
        const id = readString(message, "id");
        const threadId = readString(message, "threadId");
        if (!id || !threadId) continue;
        messages.set(id, { id, threadId, labelIds: readLabelIds(message) });
      }
    }
    pageToken = readString(page, "nextPageToken") ?? null;
  } while (pageToken);

  return { messages: [...messages.values()], latestHistoryId, expired: false };
}

export async function fetchGmailMessageMetadata(
  call: GmailApiCaller,
  messageId: string,
): Promise<GmailMessageMetadata | null> {
  const url = new URL(`${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "metadata");
  for (const header of ["From", "To", "Cc", "Subject", "Date", "Message-ID"]) {
    url.searchParams.append("metadataHeaders", header);
  }

  let message: Record<string, unknown>;
  try {
    message = asRecord(await call("GET", url.toString()));
  } catch (error) {
    // Deleted between history listing and fetch — nothing to buffer.
    if (error instanceof GoogleApiRequestError && error.status === 404) return null;
    throw error;
  }

  const headers = readHeaders(asRecord(message.payload));
  return {
    id: readString(message, "id") ?? messageId,
    threadId: readString(message, "threadId") ?? "",
    labelIds: readLabelIds(message),
    subject: headers.subject ?? null,
    from: headers.from ?? null,
    to: headers.to ?? null,
    cc: headers.cc ?? null,
    rfc822MessageId: headers.messageId ?? null,
    snippet: readString(message, "snippet") ?? null,
    internalDate: readInternalDate(message),
  };
}

export async function fetchGmailThreadSnapshot(
  call: GmailApiCaller,
  threadId: string,
): Promise<GmailThreadSnapshot> {
  const url = new URL(`${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}`);
  url.searchParams.set("format", "full");
  const thread = asRecord(await call("GET", url.toString()));

  const messages = asArray(thread.messages).flatMap((entry) => {
    const message = asRecord(entry);
    const id = readString(message, "id");
    if (!id) return [];
    const headers = readHeaders(asRecord(message.payload));
    const rawBody = collectTextParts(asRecord(message.payload)).join("\n\n").trim();
    return [
      {
        id,
        labelIds: readLabelIds(message),
        subject: headers.subject ?? null,
        from: headers.from ?? null,
        to: headers.to ?? null,
        cc: headers.cc ?? null,
        snippet: readString(message, "snippet") ?? null,
        internalDate: readInternalDate(message),
        bodyText: truncate(stripQuotedReply(rawBody), MAX_BODY_CHARS),
      },
    ];
  });

  return { threadId: readString(thread, "id") ?? threadId, messages };
}

// Best-effort quoted-reply removal so thread windows don't repeat every prior
// message once per reply. The evidence snapshot keeps whatever survives here,
// so being conservative (keeping too much) is the safe failure mode.
export function stripQuotedReply(body: string): string {
  const lines = body.split("\n");
  let cut = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (/^On .{4,200} wrote:$/.test(line) || /^-{2,}\s*Original Message\s*-{0,}$/i.test(line)) {
      cut = index;
      break;
    }
    if (line.startsWith(">")) {
      // Only cut at a quote run that continues (or ends the message) — a lone
      // inline "> quoted" line mid-reply stays.
      const next = lines[index + 1]?.trim();
      if (next === undefined || next.startsWith(">") || next === "") {
        cut = index;
        break;
      }
    }
  }
  return lines.slice(0, cut).join("\n").trim() || body.trim();
}

function readHeaders(payload: Record<string, unknown>) {
  const headers: { from?: string; to?: string; cc?: string; subject?: string; messageId?: string } =
    {};
  for (const entry of asArray(payload.headers)) {
    const record = asRecord(entry);
    const name = readString(record, "name")?.toLowerCase();
    const value = readString(record, "value");
    if (!name || !value) continue;
    if (name === "from" || name === "to" || name === "cc" || name === "subject") {
      headers[name] = value;
    } else if (name === "message-id") {
      headers.messageId = value;
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

function readLabelIds(message: Record<string, unknown>): string[] {
  return asArray(message.labelIds).filter((label): label is string => typeof label === "string");
}

// Gmail internalDate is epoch milliseconds as a string.
function readInternalDate(message: Record<string, unknown>): Date | null {
  const raw = readString(message, "internalDate");
  if (!raw) return null;
  const millis = Number(raw);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis) : null;
}

function decodeBase64Url(value: string) {
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function truncate(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars).trimEnd()}...` : value;
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
