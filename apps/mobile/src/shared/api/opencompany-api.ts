import { type RunEventStreamOptions, streamRunEvents } from "@opencompany/protocol/run-stream";
import {
  AttachmentUploadEnvelopeSchema,
  CancelRunEnvelopeSchema,
  ClaudeCodeAuthStatusEnvelopeSchema,
  CodexAuthStatusEnvelopeSchema,
  ConversationEnvelopeSchema,
  ConversationPageSchema,
  ConversationShareEnvelopeSchema,
  CreateMessageBodySchema,
  CreateMessageEnvelopeSchema,
  CreateTaskBodySchema,
  CreateTaskCommentBodySchema,
  CreateTaskCommentEnvelopeSchema,
  CreateTaskEnvelopeSchema,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  type GitHubRepositoryAccessDto,
  GitHubRepositoryAccessSchema,
  type IdentityDto,
  IdentityEnvelopeSchema,
  type IdentityUserDto,
  type IdentityWorkspaceDto,
  InvokeWorkflowBodySchema,
  MessagePageSchema,
  MessagePresentationEnvelopeSchema,
  ResolveApprovalBodySchema,
  ResolveApprovalEnvelopeSchema,
  RunEnvelopeSchema,
  SessionPullRequestListSchema,
  UpdateConversationBodySchema,
  UpdateConversationEnvelopeSchema,
  UpdateTaskBodySchema,
  UpdateTaskEnvelopeSchema,
  type WorkspaceActivationDto,
  WorkspaceActivationEnvelopeSchema,
} from "@opencompany/protocol/schemas";
import { PROTOCOL_VERSION } from "@opencompany/protocol/version";
import { fetch as expoFetch } from "expo/fetch";
import { File } from "expo-file-system";
import { z } from "zod";

const parseApiOrigin = (): string => {
  const value = process.env.EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN?.trim();
  if (!value) throw new Error("EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN is required.");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN must be a valid URL.");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN must be an http(s) origin without credentials, a path, query parameters, or a fragment.",
    );
  }
  return url.origin;
};

export const API_ORIGIN = parseApiOrigin();

/**
 * The web app runs beside the API: `api.` becomes `my.` on hosted origins, and the local API on
 * :3001 pairs with the local web app on :3443.
 */
const webOrigin = (apiOrigin: string): string | null => {
  const url = new URL(apiOrigin);
  if (url.hostname === "localhost" && url.port === "3001") return "https://localhost:3443";
  if (url.hostname.startsWith("api.")) return `https://my.${url.hostname.slice("api.".length)}`;
  return null;
};

const WEB_ORIGIN = webOrigin(API_ORIGIN);

export const publicShareUrl = (shareId: string): string => {
  if (!WEB_ORIGIN) throw new Error("Share links are unavailable for this server.");
  return new URL(`/share/${encodeURIComponent(shareId)}`, `${WEB_ORIGIN}/`).toString();
};

/** Where Codex and Claude Code subscriptions are connected. Null when no web app pairs with the API. */
export const WEB_INFERENCE_SETTINGS_URL = WEB_ORIGIN
  ? new URL("/settings/workspace/inference", `${WEB_ORIGIN}/`).toString()
  : null;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorEnvelope["error"]["code"],
    readonly retryable: boolean,
    readonly requestId: string | undefined,
    readonly responseBody: unknown,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface AuthenticatedIdentity extends Omit<IdentityDto, "user" | "workspaces"> {
  user: IdentityUserDto;
  workspaces: IdentityWorkspaceDto[];
}

interface AuthenticatedApiOptions {
  getAccessToken: () => Promise<string>;
  isTerminalAuthError: (error: unknown) => boolean;
  onUnauthorized: () => Promise<void>;
}

interface ListPageOptions {
  cursor?: string;
  limit?: number;
}

interface DownloadArtifactOptions {
  artifactId: string;
  versionId: string;
  download?: boolean;
}

type CreateMessageBody = z.input<typeof CreateMessageBodySchema>;
type ResolveApprovalBody = z.input<typeof ResolveApprovalBodySchema>;
type ConversationPage = z.output<typeof ConversationPageSchema>;
type ConversationEnvelope = z.output<typeof ConversationEnvelopeSchema>;
type UpdateConversationBody = z.input<typeof UpdateConversationBodySchema>;
type UpdateTaskBody = z.input<typeof UpdateTaskBodySchema>;
type CreateTaskCommentBody = z.input<typeof CreateTaskCommentBodySchema>;
type CreateTaskCommentEnvelope = z.output<typeof CreateTaskCommentEnvelopeSchema>;
type CreateTaskBody = z.input<typeof CreateTaskBodySchema>;
type CreateTaskEnvelope = z.output<typeof CreateTaskEnvelopeSchema>;
type InvokeWorkflowBody = z.input<typeof InvokeWorkflowBodySchema>;
// The composer's mention catalogs read a few fields of large, growing resources. The protocol's
// strict schemas reject any field this build does not know, and the API ships new ones ahead of the
// app, so these validate only what the menu uses and let the rest through.
const PluginCatalogEnvelopeSchema = z.object({
  data: z.array(
    z
      .object({ name: z.string().min(1), status: z.enum(["enabled", "disabled", "archived"]) })
      .loose(),
  ),
});
const SkillCatalogEnvelopeSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        scope: z.enum(["personal", "company"]).nullable(),
      })
      .loose(),
  ),
});
const WorkflowCatalogPageSchema = z.object({
  data: z.array(
    z
      .object({
        slug: z.string().min(1),
        name: z.string().min(1),
        status: z.string(),
        steps: z.array(z.object({ instructions: z.string() }).loose()),
      })
      .loose(),
  ),
  nextCursor: z.string().nullable(),
});
export type PluginCatalogItem = z.output<typeof PluginCatalogEnvelopeSchema>["data"][number];
export type SkillCatalogItem = z.output<typeof SkillCatalogEnvelopeSchema>["data"][number];
export type WorkflowCatalogItem = z.output<typeof WorkflowCatalogPageSchema>["data"][number];
type ConversationShareEnvelope = z.output<typeof ConversationShareEnvelopeSchema>;
type SessionPullRequestList = z.output<typeof SessionPullRequestListSchema>;
type ClaudeCodeAuthStatusEnvelope = z.output<typeof ClaudeCodeAuthStatusEnvelopeSchema>;
type CodexAuthStatusEnvelope = z.output<typeof CodexAuthStatusEnvelopeSchema>;
export type ClaudeCodeAuthStatus = ClaudeCodeAuthStatusEnvelope["data"];
export type CodexAuthStatus = CodexAuthStatusEnvelope["data"];
export type ReadModelName = "tasks-v1" | "chat-messages-v2" | "chat-runs-v1";
type MessagePage = z.output<typeof MessagePageSchema>;
type AttachmentUploadEnvelope = z.output<typeof AttachmentUploadEnvelopeSchema>;
type CreateMessageEnvelope = z.output<typeof CreateMessageEnvelopeSchema>;
type RunEnvelope = z.output<typeof RunEnvelopeSchema>;
type CancelRunEnvelope = z.output<typeof CancelRunEnvelopeSchema>;
type ResolveApprovalEnvelope = z.output<typeof ResolveApprovalEnvelopeSchema>;
type MessagePresentationEnvelope = z.output<typeof MessagePresentationEnvelopeSchema>;
export type MessagePresentationResult =
  | { status: "not-modified" }
  | { status: "updated"; data: MessagePresentationEnvelope["data"]; etag: string | null };

export interface AuthenticatedApi {
  getIdentity: (signal?: AbortSignal) => Promise<AuthenticatedIdentity>;
  syncIdentity: (signal?: AbortSignal) => Promise<AuthenticatedIdentity>;
  switchWorkspace: (workspaceId: string, signal?: AbortSignal) => Promise<WorkspaceActivationDto>;
  listConversations: (options?: ListPageOptions, signal?: AbortSignal) => Promise<ConversationPage>;
  getConversation: (conversationId: string, signal?: AbortSignal) => Promise<ConversationEnvelope>;
  updateConversation: (
    conversationId: string,
    body: UpdateConversationBody,
    signal?: AbortSignal,
  ) => Promise<void>;
  getConversationShare: (
    conversationId: string,
    signal?: AbortSignal,
  ) => Promise<ConversationShareEnvelope>;
  createConversationShare: (
    conversationId: string,
    signal?: AbortSignal,
  ) => Promise<ConversationShareEnvelope>;
  deleteConversationShare: (
    conversationId: string,
    signal?: AbortSignal,
  ) => Promise<ConversationShareEnvelope>;
  updateTask: (taskId: string, body: UpdateTaskBody, signal?: AbortSignal) => Promise<void>;
  createTaskComment: (
    taskId: string,
    body: CreateTaskCommentBody,
    signal?: AbortSignal,
  ) => Promise<CreateTaskCommentEnvelope>;
  /** Starts an ad-hoc Task. The server answers with the Task and its Conversation. */
  createTask: (
    body: CreateTaskBody,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => Promise<CreateTaskEnvelope>;
  /** Starts a saved workflow as a Task. `workflowId` is the workflow's slug. */
  invokeWorkflow: (
    workflowId: string,
    body: InvokeWorkflowBody,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => Promise<CreateTaskEnvelope>;
  /** Installed Plugins in the active workspace, archived ones included. */
  listPlugins: (signal?: AbortSignal) => Promise<PluginCatalogItem[]>;
  listSkillCatalog: (signal?: AbortSignal) => Promise<SkillCatalogItem[]>;
  /** Every workflow the actor can see, across all pages. */
  listWorkflows: (signal?: AbortSignal) => Promise<WorkflowCatalogItem[]>;
  /** The GitHub App installations and repositories the actor can reach as themselves. */
  listGitHubRepositories: (signal?: AbortSignal) => Promise<GitHubRepositoryAccessDto>;
  listSessionPullRequests: (signal?: AbortSignal) => Promise<SessionPullRequestList>;
  /** The acting user's own Claude Code subscription connection. Never includes the token. */
  getClaudeCodeAuth: (signal?: AbortSignal) => Promise<ClaudeCodeAuthStatus>;
  /** The acting user's own Codex connection. Never includes credentials. */
  getCodexAuth: (signal?: AbortSignal) => Promise<CodexAuthStatus>;
  /** Every current row of an authorized read model, as a one-off snapshot rather than a stream. */
  readModelSnapshot: <Schema extends z.ZodType>(
    readModel: ReadModelName,
    schema: Schema,
    query: { conversationId?: string },
    signal?: AbortSignal,
  ) => Promise<z.output<Schema>[]>;
  listMessages: (
    conversationId: string,
    options?: ListPageOptions,
    signal?: AbortSignal,
  ) => Promise<MessagePage>;
  getMessagePresentation: (
    conversationId: string,
    messageId: string,
    etag?: string | null,
    signal?: AbortSignal,
  ) => Promise<MessagePresentationResult>;
  uploadAttachment: (
    fileUri: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => Promise<AttachmentUploadEnvelope>;
  createMessage: (
    body: CreateMessageBody,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => Promise<CreateMessageEnvelope>;
  getRun: (runId: string, signal?: AbortSignal) => Promise<RunEnvelope>;
  cancelRun: (runId: string, signal?: AbortSignal) => Promise<CancelRunEnvelope>;
  resolveApproval: (
    runId: string,
    approvalId: string,
    body: ResolveApprovalBody,
    signal?: AbortSignal,
  ) => Promise<ResolveApprovalEnvelope>;
  downloadAttachment: (
    messageId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ) => Promise<Response>;
  downloadArtifact: (options: DownloadArtifactOptions, signal?: AbortSignal) => Promise<Response>;
  streamRunEvents: (
    options: Omit<RunEventStreamOptions, "baseUrl" | "fetch" | "isRetryableError">,
  ) => ReturnType<typeof streamRunEvents>;
}

interface ResponseLike {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly status: number;
  text: () => Promise<string>;
}

const retryAfterMilliseconds = (response: ResponseLike): number | undefined => {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

const fallbackCode = (status: number): ErrorEnvelope["error"]["code"] => {
  if (status === 401) return "authentication_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "internal_error";
};

const parseResponseBody = async (response: ResponseLike): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const responseError = async (response: ResponseLike): Promise<ApiRequestError> => {
  const body = await parseResponseBody(response);
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  return new ApiRequestError(
    parsed.success
      ? parsed.data.error.message
      : `The opencompany API request failed with HTTP ${response.status}.`,
    response.status,
    parsed.success ? parsed.data.error.code : fallbackCode(response.status),
    parsed.success
      ? parsed.data.error.retryable
      : response.status === 408 || response.status === 429 || response.status >= 500,
    parsed.success ? parsed.data.error.requestId : undefined,
    body,
    retryAfterMilliseconds(response),
  );
};

const ElectricMessagesSchema = z.array(
  z.object({
    key: z.string().optional(),
    value: z.record(z.string(), z.unknown()).optional(),
    headers: z.object({ operation: z.string().optional(), control: z.string().optional() }).loose(),
  }),
);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An Electric update carries only the columns that changed. The API folds some columns into a
 * nested object, such as a Task's `outcome`, so an update can hold part of that object. Merging
 * one level deep keeps the fields the update left out.
 */
const mergeReadModelRow = (
  current: Record<string, unknown> | undefined,
  update: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...current };
  for (const [field, value] of Object.entries(update)) {
    const previous = merged[field];
    merged[field] =
      isPlainObject(previous) && isPlainObject(value) ? { ...previous, ...value } : value;
  }
  return merged;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || error.name === "CanceledError");

const parseJsonResponse = async <T>(response: ResponseLike, schema: z.ZodType<T>): Promise<T> => {
  if (!response.ok) throw await responseError(response);
  return schema.parse(await parseResponseBody(response));
};

const requireOk = async (response: ResponseLike): Promise<Response> => {
  if (!response.ok) throw await responseError(response);
  return response as unknown as Response;
};

export const createAuthenticatedApi = (options: AuthenticatedApiOptions): AuthenticatedApi => {
  let unauthorizedCleanup: Promise<void> | null = null;

  const clearUnauthorizedSession = async (): Promise<void> => {
    if (!unauthorizedCleanup) {
      const cleanup = options.onUnauthorized().finally(() => {
        if (unauthorizedCleanup === cleanup) unauthorizedCleanup = null;
      });
      unauthorizedCleanup = cleanup;
    }
    await unauthorizedCleanup;
  };

  const authenticatedFetch: typeof globalThis.fetch = async (input, init) => {
    let accessToken: string;
    try {
      accessToken = await options.getAccessToken();
    } catch (error) {
      if (options.isTerminalAuthError(error)) await clearUnauthorizedSession();
      throw error;
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");

    let response: Response;
    try {
      response = (await expoFetch(input, { ...init, headers })) as Response;
    } catch (error) {
      if (init?.signal?.aborted || isAbortError(error)) throw error;
      throw new ApiRequestError(
        error instanceof Error ? error.message : "The opencompany API could not be reached.",
        0,
        "unavailable",
        true,
        undefined,
        null,
      );
    }

    if (response.status === 401) await clearUnauthorizedSession();
    return response;
  };

  const apiUrl = (
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): string => {
    const url = new URL(path, `${API_ORIGIN}/`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    return url.toString();
  };

  const request = (
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    query?: Record<string, string | number | undefined>,
  ): Promise<Response> =>
    authenticatedFetch(apiUrl(path, query), signal ? { ...init, signal } : init);

  const requestJson = async <T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    signal?: AbortSignal,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> => parseJsonResponse(await request(path, init, signal, query), schema);

  return {
    getIdentity: async (signal) =>
      (
        await requestJson<{ data: AuthenticatedIdentity }>(
          "v1/identity",
          IdentityEnvelopeSchema,
          undefined,
          signal,
        )
      ).data as AuthenticatedIdentity,
    syncIdentity: async (signal) =>
      (
        await requestJson<{ data: AuthenticatedIdentity }>(
          "v1/identity/sync",
          IdentityEnvelopeSchema,
          { method: "POST" },
          signal,
        )
      ).data as AuthenticatedIdentity,
    switchWorkspace: async (workspaceId, signal) =>
      (
        await requestJson<{ data: WorkspaceActivationDto }>(
          `v1/workspaces/${encodeURIComponent(workspaceId)}/switch`,
          WorkspaceActivationEnvelopeSchema,
          { method: "POST" },
          signal,
        )
      ).data,
    listConversations: async (page = {}, signal) =>
      requestJson("v1/conversations", ConversationPageSchema, undefined, signal, {
        cursor: page.cursor,
        limit: page.limit ?? 100,
      }),
    getConversation: async (conversationId, signal) =>
      requestJson(
        `v1/conversations/${encodeURIComponent(conversationId)}`,
        ConversationEnvelopeSchema,
        undefined,
        signal,
      ),
    updateConversation: async (conversationId, body, signal) => {
      await requestJson(
        `v1/conversations/${encodeURIComponent(conversationId)}`,
        UpdateConversationEnvelopeSchema,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(UpdateConversationBodySchema.parse(body)),
        },
        signal,
      );
    },
    getConversationShare: async (conversationId, signal) =>
      requestJson(
        `v1/conversations/${encodeURIComponent(conversationId)}/share`,
        ConversationShareEnvelopeSchema,
        undefined,
        signal,
      ),
    createConversationShare: async (conversationId, signal) =>
      requestJson(
        `v1/conversations/${encodeURIComponent(conversationId)}/share`,
        ConversationShareEnvelopeSchema,
        { method: "PUT" },
        signal,
      ),
    deleteConversationShare: async (conversationId, signal) =>
      requestJson(
        `v1/conversations/${encodeURIComponent(conversationId)}/share`,
        ConversationShareEnvelopeSchema,
        { method: "DELETE" },
        signal,
      ),
    updateTask: async (taskId, body, signal) => {
      await requestJson(
        `v1/tasks/${encodeURIComponent(taskId)}`,
        UpdateTaskEnvelopeSchema,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(UpdateTaskBodySchema.parse(body)),
        },
        signal,
      );
    },
    createTaskComment: async (taskId, body, signal) =>
      requestJson(
        `v1/tasks/${encodeURIComponent(taskId)}/comments`,
        CreateTaskCommentEnvelopeSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(CreateTaskCommentBodySchema.parse(body)),
        },
        signal,
      ),
    createTask: async (body, idempotencyKey, signal) =>
      requestJson(
        "v1/tasks",
        CreateTaskEnvelopeSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(CreateTaskBodySchema.parse(body)),
        },
        signal,
      ),
    invokeWorkflow: async (workflowId, body, idempotencyKey, signal) =>
      requestJson(
        `v1/workflows/${encodeURIComponent(workflowId)}/invoke`,
        CreateTaskEnvelopeSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(InvokeWorkflowBodySchema.parse(body)),
        },
        signal,
      ),
    listPlugins: async (signal) =>
      (await requestJson("v1/plugins", PluginCatalogEnvelopeSchema, undefined, signal)).data,
    listSkillCatalog: async (signal) =>
      (await requestJson("v1/skills/catalog", SkillCatalogEnvelopeSchema, undefined, signal)).data,
    listWorkflows: async (signal) => {
      const workflows: WorkflowCatalogItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await requestJson(
          "v1/workflows",
          WorkflowCatalogPageSchema,
          undefined,
          signal,
          {
            cursor,
            limit: 100,
          },
        );
        workflows.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return workflows;
    },
    listGitHubRepositories: async (signal) => {
      // This route lives outside /v1 and redirects a request it cannot identify to the web sign-in
      // page instead of answering 401. Follow no redirect: an HTML sign-in page is not data. The
      // session itself is still valid, so this never signs the user out.
      const response = await request(
        "integrations/github-user/installations",
        { redirect: "manual" },
        signal,
      );
      if (response.status === 0 || (response.status >= 300 && response.status < 400))
        throw new ApiRequestError(
          "GitHub repositories could not be loaded for this session.",
          401,
          "authentication_required",
          false,
          undefined,
          null,
        );
      return parseJsonResponse(response, GitHubRepositoryAccessSchema);
    },
    listSessionPullRequests: async (signal) =>
      requestJson("v1/session-pull-requests", SessionPullRequestListSchema, undefined, signal),
    getClaudeCodeAuth: async (signal) =>
      (
        await requestJson<ClaudeCodeAuthStatusEnvelope>(
          "v1/engine-auth/claude-code",
          ClaudeCodeAuthStatusEnvelopeSchema,
          undefined,
          signal,
        )
      ).data,
    getCodexAuth: async (signal) =>
      (
        await requestJson<CodexAuthStatusEnvelope>(
          "v1/engine-auth/codex",
          CodexAuthStatusEnvelopeSchema,
          undefined,
          signal,
        )
      ).data,
    readModelSnapshot: async (readModel, schema, query, signal) => {
      const rows = new Map<string, Record<string, unknown>>();
      let offset = "-1";
      let handle: string | undefined;
      // Electric pages a large initial snapshot. Each response names the next offset, and the
      // snapshot is complete once a response carries the up-to-date control message.
      for (let page = 0; page < 100; page += 1) {
        const response = await request(`v1/read-models/${readModel}`, undefined, signal, {
          ...query,
          offset,
          handle,
        });
        if (response.status === 409) {
          // The server rotated its shape. Start the snapshot again from the beginning.
          rows.clear();
          offset = "-1";
          handle = undefined;
          continue;
        }
        const messages = ElectricMessagesSchema.parse(
          await parseJsonResponse(response, z.unknown()),
        );
        let upToDate = false;
        for (const message of messages) {
          if (message.headers.control === "up-to-date") upToDate = true;
          if (!message.key || !message.value) continue;
          if (message.headers.operation === "delete") rows.delete(message.key);
          else rows.set(message.key, mergeReadModelRow(rows.get(message.key), message.value));
        }
        if (upToDate) return [...rows.values()].map((row) => schema.parse(row));
        const nextOffset = response.headers.get("electric-offset");
        const nextHandle = response.headers.get("electric-handle");
        if (!nextOffset || !nextHandle) {
          throw new Error("The read model response did not name its next page.");
        }
        offset = nextOffset;
        handle = nextHandle;
      }
      throw new Error("The read model snapshot did not finish.");
    },
    listMessages: async (conversationId, page = {}, signal) =>
      requestJson(
        `v1/conversations/${encodeURIComponent(conversationId)}/messages`,
        MessagePageSchema,
        undefined,
        signal,
        { cursor: page.cursor, limit: page.limit ?? 100 },
      ),
    getMessagePresentation: async (conversationId, messageId, etag, signal) => {
      const response = await request(
        `v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/presentation`,
        etag ? { headers: { "If-None-Match": etag } } : undefined,
        signal,
      );
      if (response.status === 304) return { status: "not-modified" };
      return {
        status: "updated",
        data: (
          await parseJsonResponse<MessagePresentationEnvelope>(
            response,
            MessagePresentationEnvelopeSchema,
          )
        ).data,
        etag: response.headers.get("ETag"),
      };
    },
    uploadAttachment: async (fileUri, idempotencyKey, signal) => {
      const body = new FormData();
      body.append("file", new File(fileUri) as unknown as Blob);
      return requestJson(
        "v1/attachments",
        AttachmentUploadEnvelopeSchema,
        { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body },
        signal,
      );
    },
    createMessage: async (body, idempotencyKey, signal) =>
      requestJson(
        "v1/messages",
        CreateMessageEnvelopeSchema,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
            "X-OpenCompany-Protocol-Version": PROTOCOL_VERSION,
          },
          body: JSON.stringify(CreateMessageBodySchema.parse(body)),
        },
        signal,
      ),
    getRun: async (runId, signal) =>
      requestJson(`v1/runs/${encodeURIComponent(runId)}`, RunEnvelopeSchema, undefined, signal),
    cancelRun: async (runId, signal) =>
      requestJson(
        `v1/runs/${encodeURIComponent(runId)}/cancel`,
        CancelRunEnvelopeSchema,
        { method: "POST" },
        signal,
      ),
    resolveApproval: async (runId, approvalId, body, signal) =>
      requestJson(
        `v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
        ResolveApprovalEnvelopeSchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ResolveApprovalBodySchema.parse(body)),
        },
        signal,
      ),
    downloadAttachment: async (messageId, attachmentId, signal) =>
      requireOk(
        await request(
          `v1/chat-attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`,
          undefined,
          signal,
        ),
      ),
    downloadArtifact: async ({ artifactId, versionId, download }, signal) =>
      requireOk(
        await request(
          `v1/chat-artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}`,
          undefined,
          signal,
          { download: download === undefined ? undefined : download ? "1" : "0" },
        ),
      ),
    streamRunEvents: (streamOptions) =>
      streamRunEvents({
        ...streamOptions,
        baseUrl: API_ORIGIN,
        fetch: authenticatedFetch,
        isRetryableError: (error) =>
          error instanceof ApiRequestError ? error.retryable : error instanceof TypeError,
      }),
  };
};

export const isUnauthorizedApiError = (error: unknown): boolean =>
  error instanceof ApiRequestError && error.status === 401;

export const isRetryableApiError = (error: unknown): boolean =>
  error instanceof ApiRequestError
    ? error.retryable
    : !isAbortError(error) && !(error instanceof Error && error.name === "ZodError");
