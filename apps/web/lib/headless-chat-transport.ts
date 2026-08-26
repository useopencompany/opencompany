"use client";

import { captureException } from "@opencompany/observability";
import {
  type CreateMessageBody,
  createApiClient,
  type MessageEngine,
  MessageEngineSchema,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  type RunEventDto,
  streamRunEvents,
} from "@opencompany/protocol";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import { awaitHeadlessChatTransaction } from "./headless-chat-collections";
import {
  HeadlessChatUiProjector,
  type HeadlessToolCallCheckpoint,
} from "./headless-chat-ui-projector";

// Keep the storage key stable so older sessions can be discovered and migrated by payload version.
const STORAGE_PREFIX = "opencompany:headless-chat:v1:";
const CHECKPOINT_VERSION = 2;

type HeadlessRunStatus = "queued" | "running" | "paused" | "completed" | "failed" | "canceled";

type HeadlessRunState = {
  checkpointVersion: typeof CHECKPOINT_VERSION;
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  model: string;
  content?: string;
  textSegment?: number;
  activeToolCalls: HeadlessToolCallCheckpoint[];
  cursor?: string;
  presentationCursor?: string;
  status: HeadlessRunStatus;
};

type MessageMetadata = {
  sessionId?: string;
  runId?: string;
  model?: string;
  mentions?: Array<{ kind: string; id: string }>;
  attachments?: Array<{ id: string }>;
};

export type HeadlessMessageAccepted = {
  conversationId: string;
  runId: string;
  assistantMessageId: string;
  transactionId: string;
};

export type ResolveHeadlessApprovalInput = {
  chatId: string;
  approvalId: string;
  approved: boolean;
  runId?: string;
  assistantMessageId?: string;
  model?: string;
  signal?: AbortSignal;
};

type TransportOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  onAccepted?: (input: HeadlessMessageAccepted) => void;
  onReconciled?: (input: HeadlessMessageAccepted) => void;
};

export class HeadlessChatTransport<UI_MESSAGE extends UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiFetchImpl: typeof globalThis.fetch;
  private onAccepted: TransportOptions["onAccepted"];
  private onReconciled: TransportOptions["onReconciled"];

  constructor(private readonly options: TransportOptions = {}) {
    this.fetchImpl = bindFetchToRuntime(options.fetch);
    this.apiFetchImpl = createHeadlessChatApiFetch({
      baseUrl: this.baseUrl(),
      fetch: this.fetchImpl,
    });
    this.onAccepted = options.onAccepted;
    this.onReconciled = options.onReconciled;
  }

  setEventHandlers(handlers: Pick<TransportOptions, "onAccepted" | "onReconciled">) {
    this.onAccepted = handlers.onAccepted;
    this.onReconciled = handlers.onReconciled;
    return () => {
      if (this.onAccepted === handlers.onAccepted) this.onAccepted = undefined;
      if (this.onReconciled === handlers.onReconciled) this.onReconciled = undefined;
    };
  }

  async sendMessages(input: Parameters<ChatTransport<UI_MESSAGE>["sendMessages"]>[0]) {
    const latest = input.messages.at(-1);
    if (!latest) throw new Error("A Chat message is required.");
    if (latest.role !== "user") throw new Error("Only user Messages can start a Run.");

    const request = requestContext(input.body);
    const metadata = messageMetadata(latest);
    const attachmentIds = metadata.attachments?.map((attachment) => attachment.id) ?? [];
    const model = request.model;
    const body: CreateMessageBody = {
      ...(request.sessionId ? { conversationId: request.sessionId } : {}),
      ...(!request.sessionId && request.newSessionId
        ? { clientConversationId: request.newSessionId }
        : {}),
      clientMessageId: latest.id,
      content: textFromMessage(latest),
      engine: request.engine,
      ...(model ? { model } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
      ...(metadata.mentions?.length
        ? {
            mentions: metadata.mentions
              .filter((mention) => mention.kind === "skill")
              .map((mention) => ({ kind: "skill" as const, id: mention.id })),
          }
        : {}),
    };
    const client = createApiClient(this.baseUrl(), {
      fetch: this.apiFetchImpl,
    });
    const response = await client.v1.messages.$post(
      {
        header: {
          "idempotency-key": idempotencyKey(latest.id),
          [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
        },
        json: body,
      },
      input.abortSignal ? { init: { signal: input.abortSignal } } : undefined,
    );
    if (!response.ok) throw await responseError(response);
    const envelope = await response.json();
    const state: HeadlessRunState = {
      checkpointVersion: CHECKPOINT_VERSION,
      runId: envelope.data.runId,
      conversationId: envelope.data.conversationId,
      assistantMessageId: envelope.data.assistantMessageId,
      model: envelope.data.model ?? model ?? "",
      activeToolCalls: [],
      status: "queued",
    };
    writeRunStateAliases(input.chatId, state);
    const accepted = {
      conversationId: state.conversationId,
      runId: state.runId,
      assistantMessageId: state.assistantMessageId,
      transactionId: envelope.data.transactionId,
    };
    this.onAccepted?.(accepted);
    void reconcileAcceptedMessage(accepted)
      .then(() => this.onReconciled?.(accepted))
      .catch((error) => reportReconciliationFailure(error, accepted));
    return this.uiStream(input.chatId, state, input.abortSignal);
  }

  async reconnectToStream(input: Parameters<ChatTransport<UI_MESSAGE>["reconnectToStream"]>[0]) {
    const state = readRunState(input.chatId);
    if (!state || isTerminal(state.status) || state.status === "paused") return null;
    const client = createApiClient(this.baseUrl(), {
      fetch: this.apiFetchImpl,
    });
    const response = await client.v1.runs[":runId"].$get({
      param: { runId: state.runId },
    });
    if (!response.ok) return null;
    const run = (await response.json()).data;
    state.status = run.status;
    writeRunStateAliases(input.chatId, state);
    if (isTerminal(state.status) || state.status === "paused") return null;
    return this.uiStream(input.chatId, state);
  }

  async cancel(chatId: string) {
    const state = readRunState(chatId);
    if (!state || isTerminal(state.status)) return false;
    const client = createApiClient(this.baseUrl(), {
      fetch: this.apiFetchImpl,
    });
    const response = await client.v1.runs[":runId"].cancel.$post({
      param: { runId: state.runId },
    });
    if (!response.ok) throw await responseError(response);
    state.status = (await response.json()).data.status;
    writeRunStateAliases(chatId, state);
    return true;
  }

  async resolveApproval(input: ResolveHeadlessApprovalInput) {
    let state = readRunState(input.chatId);
    if (input.runId && state?.runId !== input.runId) state = null;
    if (!state && input.runId && input.assistantMessageId) {
      const client = createApiClient(this.baseUrl(), {
        fetch: this.apiFetchImpl,
      });
      const response = await client.v1.runs[":runId"].$get({
        param: { runId: input.runId },
      });
      if (!response.ok) throw await responseError(response);
      const run = (await response.json()).data;
      state = {
        checkpointVersion: CHECKPOINT_VERSION,
        runId: run.id,
        conversationId: run.conversationId,
        assistantMessageId: input.assistantMessageId,
        model: input.model ?? run.model,
        activeToolCalls: [],
        status: run.status,
      };
      writeRunStateAliases(input.chatId, state);
    }
    if (!state) throw new Error("The durable Run for this approval is no longer available.");
    const client = createApiClient(this.baseUrl(), {
      fetch: this.apiFetchImpl,
    });
    const response = await client.v1.runs[":runId"].approvals[":approvalId"].$post(
      {
        param: { runId: state.runId, approvalId: input.approvalId },
        json: { resolution: input.approved ? "approved" : "denied" },
      },
      input.signal ? { init: { signal: input.signal } } : undefined,
    );
    if (!response.ok) throw await responseError(response);
    state.status = "queued";
    writeRunStateAliases(input.chatId, state);
  }

  private uiStream(
    chatId: string,
    initialState: HeadlessRunState,
    signal?: AbortSignal,
  ): ReadableStream<UIMessageChunk> {
    const state = { ...initialState };
    const fetchImpl = this.apiFetchImpl;
    const baseUrl = this.baseUrl();
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        const projector = new HeadlessChatUiProjector(
          state.assistantMessageId,
          state.content,
          state.textSegment,
          state.activeToolCalls,
        );
        controller.enqueue({
          type: "start",
          messageId: state.assistantMessageId,
          messageMetadata: {
            sessionId: state.conversationId,
            runId: state.runId,
            ...(state.model ? { model: state.model } : {}),
          },
        });
        for (const chunk of projector.rehydrate()) controller.enqueue(chunk);
        try {
          for await (const event of streamRunEvents({
            baseUrl,
            runId: state.runId,
            ...(state.cursor ? { cursor: state.cursor } : {}),
            ...(state.presentationCursor ? { presentationCursor: state.presentationCursor } : {}),
            ...(signal ? { signal } : {}),
            fetch: fetchImpl,
          })) {
            for (const chunk of projector.project(event)) controller.enqueue(chunk);
            state.content = projector.content;
            state.textSegment = projector.segment;
            state.activeToolCalls = projector.toolCallCheckpoint;
            if (event.type === "message.presentation_delta") {
              state.presentationCursor = event.presentationCursor;
            } else {
              state.cursor = event.cursor;
              state.status = statusFromEvent(event, state.status);
            }
            writeRunStateAliases(chatId, state);
          }
          for (const chunk of projector.finish()) controller.enqueue(chunk);
          controller.enqueue({
            type: "finish",
            finishReason:
              state.status === "failed"
                ? "error"
                : state.status === "paused"
                  ? "tool-calls"
                  : "stop",
            messageMetadata: {
              sessionId: state.conversationId,
              runId: state.runId,
              ...(state.model ? { model: state.model } : {}),
            },
          });
          controller.close();
        } catch (error) {
          if (signal?.aborted) {
            controller.enqueue({
              type: "abort",
              reason: "Disconnected from the Run stream.",
            });
            controller.close();
            return;
          }
          controller.error(error);
        }
      },
    });
  }

  private baseUrl() {
    if (this.options.baseUrl) return this.options.baseUrl;
    return headlessChatApiBaseUrl();
  }
}

export async function startHeadlessBackgroundChat(
  input: {
    content: string;
    clientConversationId: string;
    clientMessageId: string;
    model: string;
    engine?: MessageEngine;
    attachmentIds?: string[];
    mentions?: Array<{ kind: "skill"; id: string }>;
  },
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  const fetchImpl = bindFetchToRuntime(options.fetch);
  const apiFetchImpl = createHeadlessChatApiFetch({
    baseUrl,
    fetch: fetchImpl,
  });
  const client = createApiClient(baseUrl, { fetch: apiFetchImpl });
  const response = await client.v1.messages.$post({
    header: {
      "idempotency-key": idempotencyKey(input.clientMessageId),
      [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
    },
    json: {
      clientConversationId: input.clientConversationId,
      clientMessageId: input.clientMessageId,
      content: input.content,
      engine: input.engine ?? { type: "opencompany", schemaVersion: 1 },
      model: input.model,
      ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
      ...(input.mentions?.length ? { mentions: input.mentions } : {}),
    },
  });
  if (!response.ok) throw await responseError(response);
  const data = (await response.json()).data;
  const accepted = {
    conversationId: data.conversationId,
    runId: data.runId,
    assistantMessageId: data.assistantMessageId,
    transactionId: data.transactionId,
  };
  void reconcileAcceptedMessage(accepted).catch((error) =>
    reportReconciliationFailure(error, accepted),
  );
  // Accepting a durable Run and observing it to completion are separate lifecycle phases. Return
  // as soon as the command is accepted so callers never hold interactive UI hostage to a
  // potentially long-running background stream.
  const completion = consumeBackgroundRunEvents({
    baseUrl,
    runId: data.runId,
    fetch: apiFetchImpl,
  });
  return { ...data, completion };
}

async function consumeBackgroundRunEvents(input: {
  baseUrl: string;
  runId: string;
  fetch: typeof globalThis.fetch;
}) {
  // Background Chat has no mounted useChat consumer, so keep consuming semantic events until the
  // Run settles or pauses. Projection and presentation remain owned by Postgres/Electric.
  for await (const event of streamRunEvents(input)) void event;
}

function reconcileAcceptedMessage(accepted: HeadlessMessageAccepted) {
  return awaitHeadlessChatTransaction({
    conversationId: accepted.conversationId,
    transactionId: accepted.transactionId,
  });
}

function reportReconciliationFailure(error: unknown, accepted: HeadlessMessageAccepted) {
  captureException(error, {
    event: "opencompany.chat_read_model_reconciliation_failed",
    session_id: accepted.conversationId,
    run_id: accepted.runId,
    message_id: accepted.assistantMessageId,
    transaction_id: accepted.transactionId,
  });
}

function bindFetchToRuntime(fetchImpl = globalThis.fetch) {
  return fetchImpl.bind(globalThis);
}

function requestContext(body: object | undefined) {
  const value = (body ?? {}) as Record<string, unknown>;
  return {
    sessionId: stringValue(value.sessionId),
    newSessionId: stringValue(value.newSessionId),
    model: stringValue(value.model),
    engine: chatEngine(value.engine),
  };
}

function chatEngine(value: unknown): MessageEngine {
  const parsed = MessageEngineSchema.safeParse(value);
  return parsed.success ? parsed.data : { type: "opencompany", schemaVersion: 1 };
}

function messageMetadata(message: UIMessage): MessageMetadata {
  return message.metadata && typeof message.metadata === "object"
    ? (message.metadata as MessageMetadata)
    : {};
}

function textFromMessage(message: UIMessage) {
  return message.parts
    .filter((part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
      Boolean(part && part.type === "text"),
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

function statusFromEvent(event: RunEventDto, current: HeadlessRunState["status"]) {
  switch (event.type) {
    case "run.queued":
      return "queued" as const;
    case "run.started":
      return "running" as const;
    case "run.paused":
      return "paused" as const;
    case "run.completed":
      return "completed" as const;
    case "run.failed":
      return "failed" as const;
    case "run.canceled":
      return "canceled" as const;
    default:
      return current;
  }
}

function idempotencyKey(messageId: string) {
  return `web-message:${messageId}`.slice(0, 200);
}

async function responseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: string | { message?: unknown; requestId?: unknown };
  } | null;
  const message =
    typeof body?.error === "string"
      ? body.error
      : typeof body?.error?.message === "string"
        ? body.error.message
        : null;
  const requestId =
    typeof body?.error === "object" && typeof body.error.requestId === "string"
      ? body.error.requestId
      : null;
  return new Error(
    `${message ?? `The Chat API request failed with HTTP ${response.status}.`}${
      requestId ? ` (request ${requestId})` : ""
    }`,
  );
}

function storageKey(chatId: string) {
  return `${STORAGE_PREFIX}${chatId}`;
}

function readRunState(chatId: string): HeadlessRunState | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(chatId)) ?? "null") as unknown;
    if (!isRecord(value)) return null;
    const runId = stringValue(value.runId);
    const conversationId = stringValue(value.conversationId);
    const assistantMessageId = stringValue(value.assistantMessageId);
    const status = runStatus(value.status);
    if (!runId || !conversationId || !assistantMessageId || !status) return null;

    const activeToolCalls = toolCallCheckpoint(value.activeToolCalls);
    const currentCheckpoint =
      value.checkpointVersion === CHECKPOINT_VERSION && activeToolCalls !== null;
    const cursor = currentCheckpoint ? stringValue(value.cursor) : undefined;
    const presentationCursor = currentCheckpoint
      ? stringValue(value.presentationCursor)
      : undefined;
    return {
      checkpointVersion: CHECKPOINT_VERSION,
      runId,
      conversationId,
      assistantMessageId,
      model: stringValue(value.model) ?? "",
      ...(typeof value.content === "string" ? { content: value.content } : {}),
      ...(isNonNegativeSafeInteger(value.textSegment) ? { textSegment: value.textSegment } : {}),
      activeToolCalls: currentCheckpoint ? activeToolCalls : [],
      ...(cursor ? { cursor } : {}),
      ...(presentationCursor ? { presentationCursor } : {}),
      status,
    };
  } catch {
    return null;
  }
}

function writeRunState(chatId: string, state: HeadlessRunState) {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(storageKey(chatId), JSON.stringify(state));
}

function writeRunStateAliases(chatId: string, state: HeadlessRunState) {
  writeRunState(chatId, state);
  if (state.conversationId !== chatId) writeRunState(state.conversationId, state);
}

function isTerminal(status: HeadlessRunState["status"]) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function runStatus(value: unknown): HeadlessRunStatus | undefined {
  return value === "queued" ||
    value === "running" ||
    value === "paused" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
    ? value
    : undefined;
}

function toolCallCheckpoint(value: unknown): HeadlessToolCallCheckpoint[] | null {
  if (!Array.isArray(value)) return null;
  const calls: HeadlessToolCallCheckpoint[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const toolCallId = stringValue(candidate.toolCallId);
    const toolName = stringValue(candidate.toolName);
    if (!toolCallId || !toolName || !("input" in candidate)) return null;
    calls.push({ toolCallId, toolName, input: candidate.input });
  }
  return calls;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
