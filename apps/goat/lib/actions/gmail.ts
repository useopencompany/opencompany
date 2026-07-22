import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  clampCount,
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  type GoatActionProviderCatalog,
  optionalNumberParam,
  optionalStringParam,
  type ResolvedGoatAction,
  requiredStringParam,
  truncateText,
} from "@/lib/actions/types";
import { GoogleAccessAuthError, googleApiCall } from "@/lib/integrations/google-access-token";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_SEARCH_RESULTS = 25;
const MAX_MESSAGE_BODY_CHARS = 8_000;
const MAX_THREAD_MESSAGE_BODY_CHARS = 2_000;
const MAX_THREAD_MESSAGES = 15;

type GmailConnection = {
  integrationId: string;
  accountEmail: string | null;
  accountName: string | null;
};

type GmailHeader = { name?: string; value?: string };

type GmailPayloadPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
};

type GmailMessagePayload = GmailPayloadPart & { headers?: GmailHeader[] };

type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePayload;
};

export async function resolveGmailActions(
  userWorkosId: string,
): Promise<GoatActionProviderCatalog | null> {
  const connections = await loadGmailConnections(userWorkosId);
  if (connections.length === 0) return null;

  const accountParam =
    connections.length > 1
      ? {
          account: {
            type: "string" as const,
            description: `Which connected Gmail account to use. One of: ${connections
              .map((connection) => JSON.stringify(connectionLabel(connection)))
              .join(", ")}.`,
          },
        }
      : {};

  const actions: ResolvedGoatAction[] = [
    {
      id: "gmail.search_messages",
      provider: "gmail",
      description:
        'Search the user\'s Gmail with Gmail search syntax, e.g. "from:jane after:2026/07/01 subject:invoice is:unread". Returns message ids with From/To/Subject/Date and a snippet; use gmail.get_message or gmail.get_thread for full content.',
      params: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "Gmail search query, including any operators." },
          limit: { type: "number", description: "Max messages to return (default 10, max 25)." },
          ...accountParam,
        },
      },
      execute: async (params, context) => {
        const connection = resolveConnection(connections, optionalStringParam(params, "account"));
        const query = requiredStringParam(params, "query");
        const limit = clampCount(optionalNumberParam(params, "limit"), 10, MAX_SEARCH_RESULTS);
        const url = new URL(`${GMAIL_BASE}/messages`);
        url.searchParams.set("q", query);
        url.searchParams.set("maxResults", String(limit));
        const listing = (await gmailApiCall(context, connection, url)) as {
          messages?: Array<{ id?: string; threadId?: string }>;
        };
        const refs = (listing.messages ?? []).filter((entry) => entry.id);
        const messages = await Promise.all(
          refs.map(async (ref) => {
            const messageUrl = new URL(`${GMAIL_BASE}/messages/${ref.id}`);
            messageUrl.searchParams.set("format", "metadata");
            for (const header of ["From", "To", "Subject", "Date"]) {
              messageUrl.searchParams.append("metadataHeaders", header);
            }
            const message = (await gmailApiCall(context, connection, messageUrl)) as GmailMessage;
            return compactMessageMetadata(message);
          }),
        );
        return { account: connectionLabel(connection), messages };
      },
    },
    {
      id: "gmail.get_message",
      provider: "gmail",
      description:
        "Fetch one Gmail message by id, including its plain-text body (truncated). Prefer gmail.get_thread when the conversation context matters.",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "Gmail message id from gmail.search_messages." },
          ...accountParam,
        },
      },
      execute: async (params, context) => {
        const connection = resolveConnection(connections, optionalStringParam(params, "account"));
        const id = requiredStringParam(params, "id");
        const url = new URL(`${GMAIL_BASE}/messages/${id}`);
        url.searchParams.set("format", "full");
        const message = (await gmailApiCall(context, connection, url)) as GmailMessage;
        return {
          account: connectionLabel(connection),
          message: compactFullMessage(message, MAX_MESSAGE_BODY_CHARS),
        };
      },
    },
    {
      id: "gmail.get_thread",
      provider: "gmail",
      description:
        "Fetch one Gmail thread by id with each message's headers and truncated plain-text body (newest 15 messages).",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "Gmail thread id from gmail.search_messages." },
          ...accountParam,
        },
      },
      execute: async (params, context) => {
        const connection = resolveConnection(connections, optionalStringParam(params, "account"));
        const id = requiredStringParam(params, "id");
        const url = new URL(`${GMAIL_BASE}/threads/${id}`);
        url.searchParams.set("format", "full");
        const thread = (await gmailApiCall(context, connection, url)) as {
          id?: string;
          messages?: GmailMessage[];
        };
        const all = thread.messages ?? [];
        const kept = all.slice(Math.max(0, all.length - MAX_THREAD_MESSAGES));
        return {
          account: connectionLabel(connection),
          threadId: thread.id,
          totalMessages: all.length,
          messages: kept.map((message) =>
            compactFullMessage(message, MAX_THREAD_MESSAGE_BODY_CHARS),
          ),
        };
      },
    },
  ];

  return {
    id: "gmail",
    label:
      connections.length === 1
        ? `Gmail (${connectionLabel(connections[0]!)})`
        : `Gmail (${connections.length} accounts)`,
    description: "Search and read messages and threads.",
    actions,
  };
}

async function loadGmailConnections(userWorkosId: string): Promise<GmailConnection[]> {
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
        eq(goatIntegrations.provider, "gmail"),
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
  connections: readonly GmailConnection[],
  account: string | undefined,
): GmailConnection {
  if (account) {
    const wanted = account.toLowerCase();
    const match = connections.find((entry) => entry.accountEmail?.toLowerCase() === wanted);
    if (!match) {
      throw new GoatActionInvalidParamsError(
        `No connected Gmail account matches ${JSON.stringify(account)}. Connected accounts: ${connections
          .map((entry) => JSON.stringify(connectionLabel(entry)))
          .join(", ")}.`,
      );
    }
    return match;
  }
  if (connections.length === 1) return connections[0]!;
  throw new GoatActionInvalidParamsError(
    `Multiple Gmail accounts are connected; pass account as one of: ${connections
      .map((entry) => JSON.stringify(connectionLabel(entry)))
      .join(", ")}.`,
  );
}

function connectionLabel(connection: GmailConnection) {
  const label = connection.accountEmail?.trim() || connection.accountName?.trim();
  if (!label) return "Google account";
  const normalized = label.replace(/\s+/g, " ");
  return normalized.length > 100 ? `${normalized.slice(0, 100)}…` : normalized;
}

async function gmailApiCall(
  context: GoatActionExecuteContext,
  connection: GmailConnection,
  url: URL,
): Promise<unknown> {
  try {
    return await googleApiCall(
      {
        userWorkosId: context.userWorkosId,
        integrationId: connection.integrationId,
        provider: "gmail",
      },
      "GET",
      url,
      { signal: context.signal },
    );
  } catch (error) {
    if (error instanceof GoogleAccessAuthError) {
      throw new GoatActionAuthError(
        "auth_expired",
        "gmail",
        `Reconnect Gmail for ${connectionLabel(connection)} in Settings → Integrations, then retry.`,
      );
    }
    throw error;
  }
}

function compactMessageMetadata(message: GmailMessage) {
  const headers = headerMap(message.payload?.headers);
  return {
    id: message.id,
    threadId: message.threadId,
    from: headers.from,
    to: headers.to,
    subject: headers.subject,
    date: headers.date,
    snippet: truncateText(message.snippet, 300),
  };
}

function compactFullMessage(message: GmailMessage, maxBodyChars: number) {
  const headers = headerMap(message.payload?.headers);
  return {
    id: message.id,
    threadId: message.threadId,
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    subject: headers.subject,
    date: headers.date,
    snippet: truncateText(message.snippet, 300),
    bodyText: truncateText(extractBodyText(message.payload), maxBodyChars),
  };
}

function headerMap(headers: GmailHeader[] | undefined) {
  const find = (name: string) =>
    headers?.find((header) => header.name?.toLowerCase() === name)?.value;
  return {
    from: find("from"),
    to: find("to"),
    cc: find("cc"),
    subject: find("subject"),
    date: find("date"),
  };
}

// Prefer text/plain parts anywhere in the MIME tree; fall back to a crude
// tag-stripped rendering of text/html.
function extractBodyText(payload: GmailMessagePayload | undefined): string | undefined {
  if (!payload) return undefined;
  const plain = collectPartText(payload, "text/plain");
  if (plain) return plain;
  const html = collectPartText(payload, "text/html");
  if (html) return stripHtml(html);
  return undefined;
}

function collectPartText(part: GmailPayloadPart, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const text = collectPartText(child, mimeType);
    if (text) return text;
  }
  return undefined;
}

function decodeBase64Url(data: string): string | undefined {
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<(?:style|script)[^>]*>[\s\S]*?<\/(?:style|script)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
