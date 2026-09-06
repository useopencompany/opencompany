import { type RunEventStreamOptions, streamRunEvents } from "@opencompany/protocol/run-stream";
import {
  AttachmentUploadEnvelopeSchema,
  CancelRunEnvelopeSchema,
  ConversationEnvelopeSchema,
  ConversationPageSchema,
  CreateMessageBodySchema,
  CreateMessageEnvelopeSchema,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  type IdentityDto,
  IdentityEnvelopeSchema,
  type IdentityUserDto,
  type IdentityWorkspaceDto,
  MessagePageSchema,
  ResolveApprovalBodySchema,
  ResolveApprovalEnvelopeSchema,
  RunEnvelopeSchema,
  type WorkspaceActivationDto,
  WorkspaceActivationEnvelopeSchema,
} from "@opencompany/protocol/schemas";
import { PROTOCOL_VERSION } from "@opencompany/protocol/version";
import { fetch as expoFetch } from "expo/fetch";
import { File } from "expo-file-system";
import type { z } from "zod";

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
type MessagePage = z.output<typeof MessagePageSchema>;
type AttachmentUploadEnvelope = z.output<typeof AttachmentUploadEnvelopeSchema>;
type CreateMessageEnvelope = z.output<typeof CreateMessageEnvelopeSchema>;
type RunEnvelope = z.output<typeof RunEnvelopeSchema>;
type CancelRunEnvelope = z.output<typeof CancelRunEnvelopeSchema>;
type ResolveApprovalEnvelope = z.output<typeof ResolveApprovalEnvelopeSchema>;

export interface AuthenticatedApi {
  getIdentity: (signal?: AbortSignal) => Promise<AuthenticatedIdentity>;
  syncIdentity: (signal?: AbortSignal) => Promise<AuthenticatedIdentity>;
  switchWorkspace: (workspaceId: string, signal?: AbortSignal) => Promise<WorkspaceActivationDto>;
  listConversations: (options?: ListPageOptions, signal?: AbortSignal) => Promise<ConversationPage>;
  getConversation: (conversationId: string, signal?: AbortSignal) => Promise<ConversationEnvelope>;
  listMessages: (
    conversationId: string,
    options?: ListPageOptions,
    signal?: AbortSignal,
  ) => Promise<MessagePage>;
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

  const authenticatedFetch: typeof globalThis.fetch = async (input, init) => {
    const accessToken = await options.getAccessToken();
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

    if (response.status === 401) {
      unauthorizedCleanup ??= options.onUnauthorized();
      await unauthorizedCleanup;
    }
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
    listMessages: async (conversationId, page = {}, signal) =>
      requestJson(
        `v1/conversations/${encodeURIComponent(conversationId)}/messages`,
        MessagePageSchema,
        undefined,
        signal,
        { cursor: page.cursor, limit: page.limit ?? 100 },
      ),
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
