import { isValidGoatBrainSourceRef } from "@opencompany/brain";
import { getDb } from "@opencompany/db/client";
import { goatIntegrations } from "@opencompany/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import { hasGoatGmailDraftScope, hasGoatGmailSendScope } from "../integrations/gmail-scopes";
import { GoogleAccessAuthError, googleApiCall } from "../integrations/google-access-token";
import { effectiveCapabilityMode, type GoatCapabilityId, providerCapability } from "./capabilities";
import {
  clampCount,
  GOAT_ACTION_EFFECTS_READ,
  GOAT_ACTION_EFFECTS_WRITE,
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
  GoatActionPermissionError,
  type GoatActionProviderCatalog,
  optionalNumberParam,
  optionalStringParam,
  type ResolvedGoatAction,
  requiredStringParam,
  truncateText,
} from "./types";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_SEARCH_RESULTS = 25;
const MAX_MESSAGE_BODY_CHARS = 8_000;
const MAX_THREAD_MESSAGE_BODY_CHARS = 2_000;
const MAX_THREAD_MESSAGES = 15;
const MAX_EMAIL_SUBJECT_CHARS = 300;
const MAX_EMAIL_BODY_CHARS = 100_000;
const MAX_EMAIL_RECIPIENTS = 50;
const MAX_EMAIL_ADDRESS_CHARS = 320;

type GmailConnection = {
  integrationId: string;
  accountEmail: string | null;
  accountName: string | null;
  scopes: string[];
  capabilityModes: unknown;
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
  const allConnections = await loadGmailConnections(userWorkosId);
  if (allConnections.length === 0) return null;

  const readConnections = eligibleConnections(allConnections, "read");
  const draftConnections = eligibleConnections(allConnections, "draft").filter(
    (connection) =>
      hasGoatGmailDraftScope(connection.scopes) && isValidEmailAddress(connection.accountEmail),
  );
  const sendConnections = eligibleConnections(allConnections, "write").filter(
    (connection) =>
      hasGoatGmailSendScope(connection.scopes) && isValidEmailAddress(connection.accountEmail),
  );
  if (
    readConnections.length === 0 &&
    draftConnections.length === 0 &&
    sendConnections.length === 0
  ) {
    return null;
  }

  const connections = readConnections;
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

  const readActions: ResolvedGoatAction[] = [
    {
      id: "gmail.search_messages",
      provider: "gmail",
      capability: "read",
      effects: GOAT_ACTION_EFFECTS_READ,
      ...permissionAnnotation("read", connections),
      description:
        'Search one page of the user\'s Gmail with Gmail search syntax, e.g. "from:jane after:2026/07/01 subject:invoice is:unread". Returns message ids with From/To/Subject/Date and a snippet; use gmail.get_message or gmail.get_thread for full content. Pass nextPageToken as pageToken to continue.',
      params: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Gmail search query, including any operators.",
          },
          limit: {
            type: "number",
            description: "Max messages to return (default 10, max 25).",
          },
          pageToken: {
            type: "string",
            description: "Next-page token returned by an earlier gmail.search_messages call.",
          },
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
        const pageToken = optionalStringParam(params, "pageToken");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const listing = (await gmailApiCall(context, connection, url)) as {
          messages?: Array<{ id?: string; threadId?: string }>;
          nextPageToken?: string;
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
            return withGmailSource(compactMessageMetadata(message), connection);
          }),
        );
        return {
          account: connectionLabel(connection),
          integrationId: connection.integrationId,
          messages,
          ...(listing.nextPageToken ? { nextPageToken: listing.nextPageToken } : {}),
        };
      },
    },
    {
      id: "gmail.get_message",
      provider: "gmail",
      capability: "read",
      effects: GOAT_ACTION_EFFECTS_READ,
      ...permissionAnnotation("read", connections),
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
          integrationId: connection.integrationId,
          message: withGmailSource(compactFullMessage(message, MAX_MESSAGE_BODY_CHARS), connection),
        };
      },
    },
    {
      id: "gmail.get_thread",
      provider: "gmail",
      capability: "read",
      effects: GOAT_ACTION_EFFECTS_READ,
      ...permissionAnnotation("read", connections),
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
          integrationId: connection.integrationId,
          threadId: thread.id,
          ...(thread.id
            ? {
                sourceRef: gmailThreadSourceRef(thread.id),
                url: gmailThreadPermalink(connection, thread.id),
              }
            : {}),
          totalMessages: all.length,
          messages: kept.map((message) =>
            withGmailSource(compactFullMessage(message, MAX_THREAD_MESSAGE_BODY_CHARS), connection),
          ),
        };
      },
    },
  ];
  const actions = [
    ...(readConnections.length > 0 ? readActions : []),
    ...(draftConnections.length > 0 ? [createDraftAction(draftConnections)] : []),
    ...(sendConnections.length > 0 ? [sendEmailAction(sendConnections)] : []),
  ];
  const labelConnections =
    readConnections.length > 0
      ? readConnections
      : draftConnections.length > 0
        ? draftConnections
        : sendConnections;
  const catalogCapabilities = [
    ...(readConnections.length > 0 ? ["search and read messages and threads"] : []),
    ...(draftConnections.length > 0 ? ["create new drafts"] : []),
    ...(sendConnections.length > 0 ? ["send new emails"] : []),
  ];

  return {
    id: "gmail",
    label:
      labelConnections.length === 1
        ? `Gmail (${connectionLabel(labelConnections[0]!)})`
        : `Gmail (${labelConnections.length} accounts)`,
    description: `Use Gmail to ${formatSentenceList(catalogCapabilities)}.`,
    actions,
  };
}

function eligibleConnections(
  connections: readonly GmailConnection[],
  capabilityId: GoatCapabilityId,
): GmailConnection[] {
  return connections.filter(
    (connection) =>
      effectiveCapabilityMode("gmail", capabilityId, connection.capabilityModes) !== "off",
  );
}

function permissionAnnotation(
  capabilityId: GoatCapabilityId,
  connections: readonly GmailConnection[],
): Pick<ResolvedGoatAction, "permissionMode" | "permission"> {
  const askIntegrationIds = connections
    .filter(
      (connection) =>
        effectiveCapabilityMode("gmail", capabilityId, connection.capabilityModes) === "ask",
    )
    .map((connection) => connection.integrationId);
  if (askIntegrationIds.length === 0) return { permissionMode: "on" };
  return {
    permissionMode: "ask",
    permission: {
      provider: "gmail",
      capabilityId,
      label: providerCapability("gmail", capabilityId)?.label ?? capabilityId,
      integrationIds: askIntegrationIds,
    },
  };
}

function createDraftAction(connections: readonly GmailConnection[]): ResolvedGoatAction {
  return {
    id: "gmail.create_draft",
    provider: "gmail",
    capability: "draft",
    effects: GOAT_ACTION_EFFECTS_WRITE,
    ...permissionAnnotation("draft", connections),
    description:
      "Save a new plain-text draft in a connected Gmail account for the user to review, edit, and manually send. Use only when the user explicitly asked to save a Gmail draft. This action never sends email, replies to threads, or attaches files.",
    params: emailActionParams(connections, "save the draft"),
    execute: async (params, context) => {
      const email = parseEmailActionParams(params, connections);
      await assertGmailDraftStillEnabled(context.userWorkosId, email.connection);

      const response = (await gmailApiCall(
        context,
        email.connection,
        new URL(`${GMAIL_BASE}/drafts`),
        {
          method: "POST",
          body: {
            message: {
              raw: createRawEmail({
                from: email.connection.accountEmail!,
                to: email.to,
                cc: email.cc,
                bcc: email.bcc,
                subject: email.subject,
                body: email.body,
              }),
            },
          },
        },
      )) as {
        id?: string;
        message?: { id?: string; threadId?: string; labelIds?: string[] };
      };
      if (!response.id || !response.message?.id) {
        throw new Error("Gmail did not return the created draft and message ids.");
      }
      return {
        account: connectionLabel(email.connection),
        integrationId: email.connection.integrationId,
        draft: {
          id: response.id,
          messageId: response.message.id,
          ...(response.message.threadId
            ? {
                threadId: response.message.threadId,
                sourceRef: gmailThreadSourceRef(response.message.threadId),
              }
            : {}),
          url: gmailDraftPermalink(email.connection, response.message.id),
          ...(Array.isArray(response.message.labelIds)
            ? {
                labelIds: response.message.labelIds
                  .filter((label): label is string => typeof label === "string")
                  .slice(0, 20),
              }
            : {}),
        },
      };
    },
  };
}

function sendEmailAction(connections: readonly GmailConnection[]): ResolvedGoatAction {
  return {
    id: "gmail.send_email",
    provider: "gmail",
    capability: "write",
    effects: GOAT_ACTION_EFFECTS_WRITE,
    ...permissionAnnotation("write", connections),
    description:
      "Send a new plain-text email from a connected Gmail account. Use only when the user explicitly asked to send it. This does not create drafts, reply to threads, or attach files.",
    params: emailActionParams(connections, "send the email"),
    execute: async (params, context) => {
      const email = parseEmailActionParams(params, connections);
      await assertGmailSendStillEnabled(context.userWorkosId, email.connection);

      const response = (await gmailApiCall(
        context,
        email.connection,
        new URL(`${GMAIL_BASE}/messages/send`),
        {
          method: "POST",
          body: {
            raw: createRawEmail({
              from: email.connection.accountEmail!,
              to: email.to,
              cc: email.cc,
              bcc: email.bcc,
              subject: email.subject,
              body: email.body,
            }),
          },
        },
      )) as { id?: string; threadId?: string; labelIds?: string[] };
      if (!response.id) {
        throw new Error("Gmail did not return the sent message id.");
      }
      return {
        account: connectionLabel(email.connection),
        integrationId: email.connection.integrationId,
        message: {
          id: response.id,
          ...(response.threadId
            ? {
                threadId: response.threadId,
                sourceRef: gmailThreadSourceRef(response.threadId),
                url: gmailThreadPermalink(email.connection, response.threadId),
              }
            : {}),
          ...(Array.isArray(response.labelIds)
            ? {
                labelIds: response.labelIds
                  .filter((label): label is string => typeof label === "string")
                  .slice(0, 20),
              }
            : {}),
        },
      };
    },
  };
}

function emailActionParams(
  connections: readonly GmailConnection[],
  accountPurpose: string,
): ResolvedGoatAction["params"] {
  const accountParam =
    connections.length > 1
      ? {
          account: {
            type: "string" as const,
            minLength: 1,
            maxLength: 400,
            description: `Which connected Gmail account should ${accountPurpose}. One of: ${connections
              .map((connection) => JSON.stringify(connectionLabel(connection)))
              .join(", ")}.`,
          },
        }
      : {};
  const required = ["to", "subject", "body"];
  if (connections.length > 1) required.push("account");

  return {
    type: "object",
    additionalProperties: false,
    required,
    properties: {
      to: {
        type: "array",
        minItems: 1,
        maxItems: MAX_EMAIL_RECIPIENTS,
        items: { type: "string", format: "email", maxLength: MAX_EMAIL_ADDRESS_CHARS },
        description: "Primary recipient email addresses.",
      },
      cc: {
        type: "array",
        maxItems: MAX_EMAIL_RECIPIENTS,
        items: { type: "string", format: "email", maxLength: MAX_EMAIL_ADDRESS_CHARS },
        description: "Optional CC recipient email addresses.",
      },
      bcc: {
        type: "array",
        maxItems: MAX_EMAIL_RECIPIENTS,
        items: { type: "string", format: "email", maxLength: MAX_EMAIL_ADDRESS_CHARS },
        description: "Optional BCC recipient email addresses.",
      },
      subject: {
        type: "string",
        minLength: 1,
        maxLength: MAX_EMAIL_SUBJECT_CHARS,
        description: "Email subject.",
      },
      body: {
        type: "string",
        minLength: 1,
        maxLength: MAX_EMAIL_BODY_CHARS,
        description: "Plain-text email body.",
      },
      ...accountParam,
    },
  };
}

type ParsedEmailActionParams = {
  connection: GmailConnection;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
};

function parseEmailActionParams(
  params: Record<string, unknown>,
  connections: readonly GmailConnection[],
): ParsedEmailActionParams {
  const hasMultipleAccounts = connections.length > 1;
  assertOnlyKnownEmailParams(params, hasMultipleAccounts);
  const connection = resolveConnection(
    connections,
    hasMultipleAccounts ? optionalStringParam(params, "account") : undefined,
  );
  const to = validateEmailAddresses(params.to, "to", true);
  const cc = validateEmailAddresses(params.cc, "cc", false);
  const bcc = validateEmailAddresses(params.bcc, "bcc", false);
  if (to.length + cc.length + bcc.length > MAX_EMAIL_RECIPIENTS) {
    throw new GoatActionInvalidParamsError(
      `An email can have at most ${MAX_EMAIL_RECIPIENTS} recipients across "to", "cc", and "bcc".`,
    );
  }
  const subject = requiredBoundedString(params, "subject", MAX_EMAIL_SUBJECT_CHARS);
  if (/[\r\n\0]/.test(subject)) {
    throw new GoatActionInvalidParamsError('"subject" cannot contain line breaks.');
  }
  return {
    connection,
    to,
    cc,
    bcc,
    subject,
    body: requiredBoundedBody(params),
  };
}

const EMAIL_PARAM_KEYS = ["to", "cc", "bcc", "subject", "body"] as const;

function assertOnlyKnownEmailParams(params: Record<string, unknown>, allowAccount: boolean): void {
  const unknown = Object.keys(params).filter(
    (key) =>
      !EMAIL_PARAM_KEYS.includes(key as (typeof EMAIL_PARAM_KEYS)[number]) &&
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

function validateEmailAddresses(value: unknown, key: string, required: boolean): string[] {
  if (value === undefined || value === null) {
    if (required) {
      throw new GoatActionInvalidParamsError(`"${key}" is required and must contain an email.`);
    }
    return [];
  }
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new GoatActionInvalidParamsError(
      `"${key}" must be ${required ? "a non-empty array" : "an array"} of email addresses.`,
    );
  }
  if (value.length > MAX_EMAIL_RECIPIENTS) {
    throw new GoatActionInvalidParamsError(
      `"${key}" allows at most ${MAX_EMAIL_RECIPIENTS} email addresses.`,
    );
  }
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new GoatActionInvalidParamsError(`"${key}" must contain only email addresses.`);
    }
    const email = entry.trim();
    if (!isValidEmailAddress(email)) {
      throw new GoatActionInvalidParamsError(
        `${JSON.stringify(entry)} is not a valid email address in "${key}".`,
      );
    }
    const normalized = email.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    emails.push(email);
  }
  return emails;
}

function isValidEmailAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EMAIL_ADDRESS_CHARS &&
    !/[\s\r\n\0]/.test(value) &&
    /^[^@]+@[^@]+\.[^@]+$/.test(value)
  );
}

function requiredBoundedString(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = requiredStringParam(params, key);
  if (value.length > maxChars) {
    throw new GoatActionInvalidParamsError(`"${key}" exceeds ${maxChars} characters.`);
  }
  return value;
}

function requiredBoundedBody(params: Record<string, unknown>) {
  const value = params.body;
  if (typeof value !== "string" || !value.trim()) {
    throw new GoatActionInvalidParamsError('"body" is required and must be a non-empty string.');
  }
  if (value.length > MAX_EMAIL_BODY_CHARS) {
    throw new GoatActionInvalidParamsError(`"body" exceeds ${MAX_EMAIL_BODY_CHARS} characters.`);
  }
  return value;
}

function createRawEmail(input: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}) {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc.length > 0 ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${encodeMimeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const normalizedBody = input.body.replace(/\r\n|\r|\n/g, "\r\n");
  const encodedBody = Buffer.from(normalizedBody, "utf8")
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${encodedBody ?? ""}`, "utf8").toString(
    "base64url",
  );
}

function encodeMimeHeader(value: string) {
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    if (current && Buffer.byteLength(current + character, "utf8") > 45) {
      chunks.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current) chunks.push(current);
  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

async function assertGmailDraftStillEnabled(
  userWorkosId: string,
  connection: GmailConnection,
): Promise<void> {
  const rows = await getDb()
    .select({
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, connection.integrationId),
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "gmail"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== "connected" || !hasGoatGmailDraftScope(row.scopes)) {
    throw new GoatActionAuthError(
      "auth_expired",
      "gmail",
      `Reconnect Gmail for ${connectionLabel(connection)} in Settings → Integrations to enable drafts, then retry.`,
    );
  }
  if (effectiveCapabilityMode("gmail", "draft", row.capabilityModes) === "off") {
    throw new GoatActionPermissionError(
      "gmail",
      `Creating drafts is turned off for ${connectionLabel(connection)}. It can be changed under Settings → Integrations.`,
    );
  }
}

async function assertGmailSendStillEnabled(
  userWorkosId: string,
  connection: GmailConnection,
): Promise<void> {
  const rows = await getDb()
    .select({
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, connection.integrationId),
        eq(goatIntegrations.userWorkosId, userWorkosId),
        eq(goatIntegrations.provider, "gmail"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== "connected" || !hasGoatGmailSendScope(row.scopes)) {
    throw new GoatActionAuthError(
      "auth_expired",
      "gmail",
      `Reconnect Gmail for ${connectionLabel(connection)} in Settings → Integrations to enable sending, then retry.`,
    );
  }
  if (effectiveCapabilityMode("gmail", "write", row.capabilityModes) === "off") {
    throw new GoatActionPermissionError(
      "gmail",
      `Sending emails is turned off for ${connectionLabel(connection)}. It can be changed under Settings → Integrations.`,
    );
  }
}

async function loadGmailConnections(userWorkosId: string): Promise<GmailConnection[]> {
  const rows = await getDb()
    .select({
      integrationId: goatIntegrations.id,
      accountEmail: goatIntegrations.accountEmail,
      accountName: goatIntegrations.accountName,
      status: goatIntegrations.status,
      scopes: goatIntegrations.scopes,
      capabilityModes: goatIntegrations.capabilityModes,
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
      scopes: row.scopes,
      capabilityModes: row.capabilityModes,
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

function formatSentenceList(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

async function gmailApiCall(
  context: GoatActionExecuteContext,
  connection: GmailConnection,
  url: URL,
  init?: { method?: "GET" | "POST"; body?: unknown },
): Promise<unknown> {
  try {
    return await googleApiCall(
      {
        userWorkosId: context.userWorkosId,
        integrationId: connection.integrationId,
        provider: "gmail",
      },
      init?.method ?? "GET",
      url,
      {
        signal: context.signal,
        ...(init?.body !== undefined ? { body: init.body } : {}),
      },
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

function withGmailSource<T extends { threadId?: string | undefined }>(
  value: T,
  connection: GmailConnection,
) {
  if (!value.threadId) return { ...value, integrationId: connection.integrationId };
  return {
    ...value,
    sourceRef: gmailThreadSourceRef(value.threadId),
    url: gmailThreadPermalink(connection, value.threadId),
    integrationId: connection.integrationId,
  };
}

function gmailThreadSourceRef(threadId: string) {
  const sourceRef = `gmail:thread:${threadId}`;
  if (!isValidGoatBrainSourceRef(sourceRef)) {
    throw new Error("Gmail returned a thread id that cannot form a Brain source reference.");
  }
  return sourceRef;
}

function gmailThreadPermalink(connection: GmailConnection, threadId: string) {
  const account = encodeURIComponent(connection.accountEmail?.trim() || "0");
  return `https://mail.google.com/mail/u/${account}/#all/${encodeURIComponent(threadId)}`;
}

function gmailDraftPermalink(connection: GmailConnection, messageId: string) {
  const account = encodeURIComponent(connection.accountEmail?.trim() || "0");
  return `https://mail.google.com/mail/u/${account}/#drafts?compose=${encodeURIComponent(messageId)}`;
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
