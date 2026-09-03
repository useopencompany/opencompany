import { randomUUID } from "node:crypto";
import { isPluginGatewayRegistrationActive } from "@opencompany/db/plugin-gateway-repository";
import { createMcpHandler } from "mcp-handler";
import * as z from "zod";
import {
  type CapabilityId,
  effectiveCapabilityMode,
  isCapabilityMode,
} from "../actions/capabilities";
import { truncateText } from "../actions/types";
import { type GmailMcpTicketPayload, verifyGmailMcpTicket } from "./gmail-mcp-ticket";
import { gmailMcpScopesSatisfied } from "./gmail-scopes";
import { GoogleAccessAuthError, googleApiCall } from "./google-access-token";
import { loadGmailIntegration } from "./google-data";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MCP_MAX_DURATION_SECONDS = 120;
const MAX_ID_CHARS = 1_024;
const MAX_LABELS_PER_REQUEST = 50;
const MAX_RECIPIENTS_PER_FIELD = 50;
const MAX_MESSAGE_BODY_CHARS = 100_000;
const MAX_ENCODED_BODY_CHARS = 200_000;
const MAX_MESSAGE_PARTS = 100;
const MAX_THREAD_MESSAGES = 100;
const MAX_LABEL_RESULTS = 500;

const TOOL_CAPABILITIES = {
  list_drafts: "query",
  get_draft: "query",
  get_thread: "query",
  get_message: "query",
  search_threads: "query",
  list_labels: "query",
  create_draft: "draft",
  label_thread: "write",
  unlabel_thread: "write",
  trash_thread: "write",
  untrash_thread: "write",
  label_message: "write",
  unlabel_message: "write",
  trash_message: "write",
  untrash_message: "write",
  create_label: "write",
} as const satisfies Record<string, CapabilityId>;

type GmailMcpToolName = keyof typeof TOOL_CAPABILITIES;
type DbLike = any;
type GmailApiCall = typeof googleApiCall;
type ExtractedMessageContent = {
  text: string[];
  html: string[];
  textChars: number;
  htmlChars: number;
  attachments: Array<{
    filename?: string;
    mimeType?: string;
    attachmentId?: string;
    size?: number;
  }>;
  omitted: boolean;
};

export type GmailMcpService = {
  handle(request: Request): Promise<Response>;
};

const resourceIdSchema = z.string().trim().min(1).max(MAX_ID_CHARS);
const pageSizeSchema = z.number().int().min(1).max(500).optional();
const pageTokenSchema = z.string().trim().min(1).max(2_048).optional();
const labelIdsSchema = z
  .array(z.string().trim().min(1).max(MAX_ID_CHARS))
  .min(1)
  .max(MAX_LABELS_PER_REQUEST);
const emailSchema = z.string().trim().email().max(320);

const listDraftsSchema = {
  pageSize: pageSizeSchema.describe("Maximum drafts to return (default 10, max 500)."),
  pageToken: pageTokenSchema,
  query: z.string().trim().min(1).max(1_000).optional(),
};

const getDraftSchema = { draftId: resourceIdSchema };
const getThreadSchema = { threadId: resourceIdSchema };
const getMessageSchema = { messageId: resourceIdSchema };

const searchThreadsSchema = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .describe('A Gmail search query such as "from:ada@example.com newer_than:30d".'),
  pageSize: pageSizeSchema.describe("Maximum threads to return (default 10, max 500)."),
  pageToken: pageTokenSchema,
  labelIds: z.array(z.string().trim().min(1).max(MAX_ID_CHARS)).max(20).optional(),
  includeSpamTrash: z.boolean().optional(),
};

const createDraftSchema = {
  to: z.array(emailSchema).max(MAX_RECIPIENTS_PER_FIELD).optional(),
  cc: z.array(emailSchema).max(MAX_RECIPIENTS_PER_FIELD).optional(),
  bcc: z.array(emailSchema).max(MAX_RECIPIENTS_PER_FIELD).optional(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(MAX_MESSAGE_BODY_CHARS).optional(),
  htmlBody: z.string().max(MAX_MESSAGE_BODY_CHARS).optional(),
  replyToMessageId: resourceIdSchema.optional(),
};

const labelThreadSchema = { threadId: resourceIdSchema, labelIds: labelIdsSchema };
const labelMessageSchema = { messageId: resourceIdSchema, labelIds: labelIdsSchema };
const threadIdSchema = { threadId: resourceIdSchema };
const messageIdSchema = { messageId: resourceIdSchema };
const createLabelSchema = {
  name: z.string().trim().min(1).max(225),
  messageListVisibility: z.enum(["show", "hide"]).optional(),
  labelListVisibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
};

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DRAFT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const IDEMPOTENT_WRITE_ANNOTATIONS = {
  ...WRITE_ANNOTATIONS,
  idempotentHint: true,
} as const;

const TRASH_ANNOTATIONS = {
  ...IDEMPOTENT_WRITE_ANNOTATIONS,
  destructiveHint: true,
} as const;

export function createGmailMcpService(input: {
  db: DbLike;
  internalSecret: string;
  gmailApiCall?: GmailApiCall;
}): GmailMcpService {
  const gmailApiCall = input.gmailApiCall ?? googleApiCall;
  return {
    async handle(request) {
      const ticket = bearerToken(request);
      if (!ticket) return unauthorized("A Gmail MCP bearer ticket is required.");
      const payload = verifyGmailMcpTicket({ ticket, secret: input.internalSecret });
      if (!payload) return unauthorized("The Gmail MCP bearer ticket is invalid.");

      const requestPolicy = await authorizeRequest(request, payload);
      if (!requestPolicy.ok) return requestPolicy.response;

      const authorization = await authorizeTicket(input.db, payload);
      if (!authorization.ok) return authorization.response;

      const handler = createMcpHandler(
        (server) => {
          server.registerTool(
            "list_drafts",
            {
              title: "List drafts",
              description: "List draft ids in the connected Gmail account.",
              inputSchema: listDraftsSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) => runTool(() => listDrafts(gmailApiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "get_draft",
            {
              title: "Get draft",
              description: "Read one Gmail draft by id, including its headers and body.",
              inputSchema: getDraftSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) => runTool(() => getDraft(gmailApiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "search_threads",
            {
              title: "Search threads",
              description: "Search Gmail threads using Gmail's standard search syntax.",
              inputSchema: searchThreadsSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => searchThreads(gmailApiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "get_thread",
            {
              title: "Get thread",
              description: "Read the messages in one Gmail thread by id.",
              inputSchema: getThreadSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) => runTool(() => getThread(gmailApiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "get_message",
            {
              title: "Get message",
              description: "Read one Gmail message by id.",
              inputSchema: getMessageSchema,
              annotations: READ_ANNOTATIONS,
            },
            async (args) => runTool(() => getMessage(gmailApiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "list_labels",
            {
              title: "List labels",
              description: "List system and user labels in the connected Gmail account.",
              inputSchema: {},
              annotations: READ_ANNOTATIONS,
            },
            async () => runTool(() => listLabels(gmailApiCall, payload, request.signal)),
          );
          server.registerTool(
            "create_draft",
            {
              title: "Create draft",
              description:
                "Create a Gmail draft for manual review. This tool never sends the message.",
              inputSchema: createDraftSchema,
              annotations: DRAFT_ANNOTATIONS,
            },
            async (args) => runTool(() => createDraft(gmailApiCall, payload, args, request.signal)),
          );
          server.registerTool(
            "label_thread",
            {
              title: "Label thread",
              description: "Apply one or more Gmail labels to every message in a thread.",
              inputSchema: labelThreadSchema,
              annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => modifyThreadLabels(gmailApiCall, payload, args, true, request.signal)),
          );
          server.registerTool(
            "unlabel_thread",
            {
              title: "Remove thread labels",
              description: "Remove one or more Gmail labels from every message in a thread.",
              inputSchema: labelThreadSchema,
              annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => modifyThreadLabels(gmailApiCall, payload, args, false, request.signal)),
          );
          server.registerTool(
            "trash_thread",
            {
              title: "Trash thread",
              description: "Move a Gmail thread to trash without permanently deleting it.",
              inputSchema: threadIdSchema,
              annotations: TRASH_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => setThreadTrash(gmailApiCall, payload, args, true, request.signal)),
          );
          server.registerTool(
            "untrash_thread",
            {
              title: "Restore thread",
              description: "Remove a Gmail thread from trash.",
              inputSchema: threadIdSchema,
              annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => setThreadTrash(gmailApiCall, payload, args, false, request.signal)),
          );
          server.registerTool(
            "label_message",
            {
              title: "Label message",
              description: "Apply one or more Gmail labels to a message.",
              inputSchema: labelMessageSchema,
              annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => modifyMessageLabels(gmailApiCall, payload, args, true, request.signal)),
          );
          server.registerTool(
            "unlabel_message",
            {
              title: "Remove message labels",
              description: "Remove one or more Gmail labels from a message.",
              inputSchema: labelMessageSchema,
              annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
            },
            async (args) =>
              runTool(() =>
                modifyMessageLabels(gmailApiCall, payload, args, false, request.signal),
              ),
          );
          server.registerTool(
            "trash_message",
            {
              title: "Trash message",
              description: "Move a Gmail message to trash without permanently deleting it.",
              inputSchema: messageIdSchema,
              annotations: TRASH_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => setMessageTrash(gmailApiCall, payload, args, true, request.signal)),
          );
          server.registerTool(
            "untrash_message",
            {
              title: "Restore message",
              description: "Remove a Gmail message from trash.",
              inputSchema: messageIdSchema,
              annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
            },
            async (args) =>
              runTool(() => setMessageTrash(gmailApiCall, payload, args, false, request.signal)),
          );
          server.registerTool(
            "create_label",
            {
              title: "Create label",
              description: "Create a user label in the connected Gmail account.",
              inputSchema: createLabelSchema,
              annotations: WRITE_ANNOTATIONS,
            },
            async (args) => runTool(() => createLabel(gmailApiCall, payload, args, request.signal)),
          );
        },
        {
          serverInfo: { name: "opencompany-gmail", version: "0.1.0" },
          instructions:
            "Use search_threads before get_thread or get_message, create drafts only when requested, and use label or trash tools only for explicit mailbox changes. No tool sends email or permanently deletes mail.",
        },
        {
          streamableHttpEndpoint: "/mcp/plugins/gmail",
          disableSse: true,
          maxDuration: MCP_MAX_DURATION_SECONDS,
        },
      );

      try {
        return await handler(request);
      } catch (error) {
        if (error instanceof GoogleAccessAuthError) {
          return unauthorized("The connected Gmail account must be reauthorized.");
        }
        throw error;
      }
    },
  };
}

async function authorizeTicket(db: DbLike, payload: GmailMcpTicketPayload) {
  const [active, row] = await Promise.all([
    isPluginGatewayRegistrationActive(db, {
      workspaceId: payload.workspaceId,
      registrationId: payload.registrationId,
    }),
    loadGmailIntegration({ userWorkosId: payload.userWorkosId, db }),
  ]);
  if (!active) return forbidden("The Gmail plugin is no longer enabled.");
  if (
    !row ||
    row.id !== payload.integrationId ||
    row.status !== "connected" ||
    !gmailMcpScopesSatisfied(row.scopes)
  ) {
    return {
      ok: false as const,
      response: unauthorized("The connected Gmail account must be reauthorized."),
    };
  }
  if (payload.operation.type === "tools/call") {
    const capability = TOOL_CAPABILITIES[payload.operation.tool as GmailMcpToolName];
    if (!capability || capability !== payload.operation.capability) {
      return forbidden("The Gmail MCP ticket does not authorize this tool.");
    }
    const toolMode = row.toolModes?.[payload.operation.tool];
    const mode = isCapabilityMode(toolMode)
      ? toolMode
      : effectiveCapabilityMode("gmail", capability, row.capabilityModes);
    if (mode === "off") return forbidden("This Gmail capability is disabled.");
  }
  return { ok: true as const };
}

async function authorizeRequest(request: Request, payload: GmailMcpTicketPayload) {
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
    response: forbidden("The Gmail MCP ticket does not authorize this operation.").response,
  };
}

async function listDrafts(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof listDraftsSchema>>,
  signal: AbortSignal,
) {
  const pageSize = args.pageSize ?? 10;
  const url = gmailUrl("/drafts");
  url.searchParams.set("maxResults", String(pageSize));
  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
  if (args.query) url.searchParams.set("q", args.query);
  const response = asRecord(await callGmail(apiCall, payload, "GET", url, signal));
  return {
    drafts: asArray(response.drafts).slice(0, pageSize).map(compactDraftSummary),
    nextPageToken: boundedString(response.nextPageToken, 2_048),
    resultSizeEstimate: boundedNumber(response.resultSizeEstimate),
  };
}

async function getDraft(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof getDraftSchema>>,
  signal: AbortSignal,
) {
  const url = gmailUrl(`/drafts/${encodeURIComponent(args.draftId)}`);
  url.searchParams.set("format", "full");
  const response = asRecord(await callGmail(apiCall, payload, "GET", url, signal));
  return {
    id: boundedString(response.id, MAX_ID_CHARS),
    message: compactMessage(asRecord(response.message)),
  };
}

async function searchThreads(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof searchThreadsSchema>>,
  signal: AbortSignal,
) {
  const pageSize = args.pageSize ?? 10;
  const url = gmailUrl("/threads");
  url.searchParams.set("maxResults", String(pageSize));
  url.searchParams.set("q", args.query);
  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
  if (args.includeSpamTrash) url.searchParams.set("includeSpamTrash", "true");
  for (const labelId of args.labelIds ?? []) url.searchParams.append("labelIds", labelId);
  const response = asRecord(await callGmail(apiCall, payload, "GET", url, signal));
  return {
    threads: asArray(response.threads).slice(0, pageSize).map(compactThreadSummary),
    nextPageToken: boundedString(response.nextPageToken, 2_048),
    resultSizeEstimate: boundedNumber(response.resultSizeEstimate),
  };
}

async function getThread(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof getThreadSchema>>,
  signal: AbortSignal,
) {
  const url = gmailUrl(`/threads/${encodeURIComponent(args.threadId)}`);
  url.searchParams.set("format", "full");
  return compactThread(asRecord(await callGmail(apiCall, payload, "GET", url, signal)));
}

async function getMessage(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof getMessageSchema>>,
  signal: AbortSignal,
) {
  const url = gmailUrl(`/messages/${encodeURIComponent(args.messageId)}`);
  url.searchParams.set("format", "full");
  return compactMessage(asRecord(await callGmail(apiCall, payload, "GET", url, signal)));
}

async function listLabels(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  signal: AbortSignal,
) {
  const response = asRecord(await callGmail(apiCall, payload, "GET", gmailUrl("/labels"), signal));
  const labels = asArray(response.labels);
  return {
    labels: labels.slice(0, MAX_LABEL_RESULTS).map(compactLabel),
    labelsOmitted: labels.length > MAX_LABEL_RESULTS || undefined,
  };
}

async function createDraft(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof createDraftSchema>>,
  signal: AbortSignal,
) {
  if (![...(args.to ?? []), ...(args.cc ?? []), ...(args.bcc ?? [])].length) {
    throw new Error("At least one recipient is required.");
  }
  if (!args.body && !args.htmlBody) throw new Error('Either "body" or "htmlBody" is required.');

  const reply = args.replyToMessageId
    ? await loadReplyHeaders(apiCall, payload, args.replyToMessageId, signal)
    : null;
  const raw = buildRawMessage({
    subject: args.subject,
    ...(args.to ? { to: args.to } : {}),
    ...(args.cc ? { cc: args.cc } : {}),
    ...(args.bcc ? { bcc: args.bcc } : {}),
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.htmlBody !== undefined ? { htmlBody: args.htmlBody } : {}),
    reply,
  });
  const response = asRecord(
    await callGmail(apiCall, payload, "POST", gmailUrl("/drafts"), signal, {
      message: {
        raw,
        ...(reply?.threadId ? { threadId: reply.threadId } : {}),
      },
    }),
  );
  return {
    id: boundedString(response.id, MAX_ID_CHARS),
    message: compactMessageSummary(response.message),
  };
}

async function loadReplyHeaders(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  messageId: string,
  signal: AbortSignal,
) {
  const url = gmailUrl(`/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "Message-ID");
  const response = asRecord(await callGmail(apiCall, payload, "GET", url, signal));
  const headers = asArray(asRecord(response.payload).headers);
  const messageIdHeader = safeReplyHeader(headerValue(headers, "message-id"), 998);
  if (!messageIdHeader) {
    throw new Error("The original Gmail message has no usable Message-ID header.");
  }
  return {
    threadId: boundedString(response.threadId, MAX_ID_CHARS),
    messageId: messageIdHeader,
    references: messageIdHeader,
  };
}

async function modifyThreadLabels(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof labelThreadSchema>>,
  add: boolean,
  signal: AbortSignal,
) {
  const url = gmailUrl(`/threads/${encodeURIComponent(args.threadId)}/modify`);
  return compactThread(
    asRecord(
      await callGmail(apiCall, payload, "POST", url, signal, {
        [add ? "addLabelIds" : "removeLabelIds"]: args.labelIds,
      }),
    ),
  );
}

async function modifyMessageLabels(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof labelMessageSchema>>,
  add: boolean,
  signal: AbortSignal,
) {
  const url = gmailUrl(`/messages/${encodeURIComponent(args.messageId)}/modify`);
  return compactMessage(
    asRecord(
      await callGmail(apiCall, payload, "POST", url, signal, {
        [add ? "addLabelIds" : "removeLabelIds"]: args.labelIds,
      }),
    ),
  );
}

async function setThreadTrash(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof threadIdSchema>>,
  trash: boolean,
  signal: AbortSignal,
) {
  const operation = trash ? "trash" : "untrash";
  return compactThread(
    asRecord(
      await callGmail(
        apiCall,
        payload,
        "POST",
        gmailUrl(`/threads/${encodeURIComponent(args.threadId)}/${operation}`),
        signal,
      ),
    ),
  );
}

async function setMessageTrash(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof messageIdSchema>>,
  trash: boolean,
  signal: AbortSignal,
) {
  const operation = trash ? "trash" : "untrash";
  return compactMessage(
    asRecord(
      await callGmail(
        apiCall,
        payload,
        "POST",
        gmailUrl(`/messages/${encodeURIComponent(args.messageId)}/${operation}`),
        signal,
      ),
    ),
  );
}

async function createLabel(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  args: z.infer<z.ZodObject<typeof createLabelSchema>>,
  signal: AbortSignal,
) {
  return compactLabel(
    asRecord(
      await callGmail(apiCall, payload, "POST", gmailUrl("/labels"), signal, {
        name: args.name,
        ...(args.messageListVisibility
          ? { messageListVisibility: args.messageListVisibility }
          : {}),
        ...(args.labelListVisibility ? { labelListVisibility: args.labelListVisibility } : {}),
      }),
    ),
  );
}

async function callGmail(
  apiCall: GmailApiCall,
  payload: GmailMcpTicketPayload,
  method: "GET" | "POST",
  url: URL,
  signal: AbortSignal,
  body?: unknown,
) {
  return await apiCall(
    {
      userWorkosId: payload.userWorkosId,
      integrationId: payload.integrationId,
      provider: "gmail",
    },
    method,
    url,
    { signal, ...(body !== undefined ? { body } : {}) },
  );
}

function gmailUrl(path: string) {
  return new URL(`${GMAIL_BASE}${path}`);
}

function buildRawMessage(input: {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  reply?: { messageId: string; references: string } | null;
}) {
  const headers = [
    ...(input.to?.length ? [`To: ${input.to.join(", ")}`] : []),
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(input.subject, "utf8").toString("base64")}?=`,
    ...(input.reply
      ? [`In-Reply-To: ${input.reply.messageId}`, `References: ${input.reply.references}`]
      : []),
    "MIME-Version: 1.0",
  ];

  if (input.body !== undefined && input.htmlBody !== undefined) {
    const boundary = `opencompany-${randomUUID()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return Buffer.from(
      normalizeCrlf(
        [
          ...headers,
          "",
          `--${boundary}`,
          'Content-Type: text/plain; charset="UTF-8"',
          "Content-Transfer-Encoding: 8bit",
          "",
          input.body,
          `--${boundary}`,
          'Content-Type: text/html; charset="UTF-8"',
          "Content-Transfer-Encoding: 8bit",
          "",
          input.htmlBody,
          `--${boundary}--`,
          "",
        ].join("\n"),
      ),
      "utf8",
    ).toString("base64url");
  }

  headers.push(
    `Content-Type: ${input.htmlBody !== undefined ? "text/html" : "text/plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: 8bit",
  );
  return Buffer.from(
    normalizeCrlf([...headers, "", input.htmlBody ?? input.body ?? ""].join("\n")),
    "utf8",
  ).toString("base64url");
}

function normalizeCrlf(value: string) {
  return value.replace(/\r?\n/gu, "\r\n");
}

function compactDraftSummary(value: unknown) {
  const draft = asRecord(value);
  return {
    id: boundedString(draft.id, MAX_ID_CHARS),
    ...compactMessageSummary(draft.message),
  };
}

function compactMessageSummary(value: unknown) {
  const message = asRecord(value);
  return {
    messageId: boundedString(message.id, MAX_ID_CHARS),
    threadId: boundedString(message.threadId, MAX_ID_CHARS),
  };
}

function compactThreadSummary(value: unknown) {
  const thread = asRecord(value);
  return {
    id: boundedString(thread.id, MAX_ID_CHARS),
    snippet: truncateText(string(thread.snippet), 500),
    historyId: boundedString(thread.historyId, 64),
  };
}

function compactThread(value: Record<string, unknown>) {
  const messages = asArray(value.messages);
  return {
    id: boundedString(value.id, MAX_ID_CHARS),
    historyId: boundedString(value.historyId, 64),
    messages: messages
      .slice(0, MAX_THREAD_MESSAGES)
      .map((message) => compactMessage(asRecord(message))),
    messagesOmitted: messages.length > MAX_THREAD_MESSAGES || undefined,
  };
}

function compactMessage(value: Record<string, unknown>) {
  const payload = asRecord(value.payload);
  const headers = asArray(payload.headers);
  const content = extractMessageContent(payload);
  return {
    id: boundedString(value.id, MAX_ID_CHARS),
    threadId: boundedString(value.threadId, MAX_ID_CHARS),
    labelIds: stringArray(value.labelIds, 100, MAX_ID_CHARS),
    snippet: truncateText(string(value.snippet), 500),
    internalDate: boundedString(value.internalDate, 32),
    headers: {
      from: truncateText(headerValue(headers, "from"), 1_000),
      to: truncateText(headerValue(headers, "to"), 2_000),
      cc: truncateText(headerValue(headers, "cc"), 2_000),
      subject: truncateText(headerValue(headers, "subject"), 1_000),
      date: boundedString(headerValue(headers, "date"), 200),
      messageId: boundedString(headerValue(headers, "message-id"), 998),
    },
    textBody: truncateText(content.text.join("\n\n") || undefined, MAX_MESSAGE_BODY_CHARS),
    htmlBody: truncateText(content.html.join("\n\n") || undefined, MAX_MESSAGE_BODY_CHARS),
    bodyPartsOmitted: content.omitted || undefined,
    attachments: content.attachments,
  };
}

function extractMessageContent(payload: Record<string, unknown>) {
  const content: ExtractedMessageContent = {
    text: [],
    html: [],
    textChars: 0,
    htmlChars: 0,
    attachments: [],
    omitted: false,
  };
  const queue: Array<{ part: Record<string, unknown>; depth: number }> = [
    { part: payload, depth: 0 },
  ];
  let visited = 0;
  while (queue.length && visited < MAX_MESSAGE_PARTS) {
    const current = queue.shift()!;
    visited += 1;
    if (current.depth > 20) {
      content.omitted = true;
      continue;
    }
    const mimeType = boundedString(current.part.mimeType, 200);
    const filename = truncateText(string(current.part.filename), 500);
    const body = asRecord(current.part.body);
    const attachmentId = boundedString(body.attachmentId, MAX_ID_CHARS);
    if (filename || attachmentId) {
      const size = boundedNumber(body.size);
      content.attachments.push({
        ...(filename ? { filename } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(attachmentId ? { attachmentId } : {}),
        ...(size !== undefined ? { size } : {}),
      });
    } else if (mimeType === "text/plain" || mimeType === "text/html") {
      const decoded = decodeGmailBody(body.data);
      if (decoded === null) {
        content.omitted = true;
      } else if (decoded) {
        appendDecodedBody(content, mimeType, decoded);
      }
    }
    for (const part of asArray(current.part.parts)) {
      if (queue.length + visited >= MAX_MESSAGE_PARTS) {
        content.omitted = true;
        break;
      }
      queue.push({ part: asRecord(part), depth: current.depth + 1 });
    }
  }
  if (queue.length) content.omitted = true;
  return content;
}

function appendDecodedBody(
  content: ExtractedMessageContent,
  mimeType: "text/plain" | "text/html",
  decoded: string,
) {
  const bucket = mimeType === "text/plain" ? content.text : content.html;
  const countKey = mimeType === "text/plain" ? "textChars" : "htmlChars";
  const remaining = MAX_MESSAGE_BODY_CHARS - content[countKey];
  if (remaining <= 0) {
    content.omitted = true;
    return;
  }
  bucket.push(decoded.slice(0, remaining));
  content[countKey] += Math.min(decoded.length, remaining);
  if (decoded.length > remaining) content.omitted = true;
}

function decodeGmailBody(value: unknown) {
  if (typeof value !== "string" || !value) return "";
  if (value.length > MAX_ENCODED_BODY_CHARS || !/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) return null;
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function compactLabel(value: unknown) {
  const label = asRecord(value);
  return {
    id: boundedString(label.id, MAX_ID_CHARS),
    name: truncateText(string(label.name), 500),
    type: boundedString(label.type, 50),
    messageListVisibility: boundedString(label.messageListVisibility, 50),
    labelListVisibility: boundedString(label.labelListVisibility, 50),
    messagesTotal: boundedNumber(label.messagesTotal),
    messagesUnread: boundedNumber(label.messagesUnread),
    threadsTotal: boundedNumber(label.threadsTotal),
    threadsUnread: boundedNumber(label.threadsUnread),
  };
}

function headerValue(headers: unknown[], name: string) {
  const match = headers.find((header) => string(asRecord(header).name)?.toLowerCase() === name);
  return string(asRecord(match).value);
}

function safeReplyHeader(value: string | undefined, maxChars: number) {
  return value && value.length <= maxChars && !/[\r\n]/u.test(value) ? value : undefined;
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
                message: "The connected Gmail account must be reauthorized.",
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
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="gmail-mcp"' } },
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

function boundedNumber(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown, maxItems: number, maxChars: number) {
  return asArray(value)
    .slice(0, maxItems)
    .flatMap((item) => {
      const result = boundedString(item, maxChars);
      return result ? [result] : [];
    });
}
