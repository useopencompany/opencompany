"use client";

import {
  type CreateMessageBody,
  createOpenCompanyClient,
  type MessageEngine,
  MessageEngineSchema,
  type RunEventDto,
  streamRunEvents,
} from "@opencompany/protocol";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import { awaitHeadlessChatTransaction } from "./headless-chat-collections";
import { HeadlessChatUiProjector } from "./headless-chat-ui-projector";

const STORAGE_PREFIX = "opencompany:headless-chat:v1:";

type HeadlessRunState = {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  model: string;
  content?: string;
  textSegment?: number;
  startedToolCallIds?: string[];
  cursor?: string;
  presentationCursor?: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "canceled";
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
    if (latest.role === "assistant")
      return this.continueApproval(input.chatId, latest, input.abortSignal);
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
    const client = createOpenCompanyClient(this.baseUrl(), { fetch: this.apiFetchImpl });
    const response = await client.v1.messages.$post(
      {
        header: { "idempotency-key": idempotencyKey(latest.id) },
        json: body,
      },
      input.abortSignal ? { init: { signal: input.abortSignal } } : undefined,
    );
    if (!response.ok) throw await responseError(response);
    const envelope = await response.json();
    const state: HeadlessRunState = {
      runId: envelope.data.runId,
      conversationId: envelope.data.conversationId,
      assistantMessageId: envelope.data.assistantMessageId,
      model: envelope.data.model ?? model ?? "",
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
    void awaitHeadlessChatTransaction({
      conversationId: state.conversationId,
      transactionId: envelope.data.transactionId,
    })
      .then(() => this.onReconciled?.(accepted))
      .catch(() => undefined);
    return this.uiStream(input.chatId, state, input.abortSignal);
  }

  async reconnectToStream(input: Parameters<ChatTransport<UI_MESSAGE>["reconnectToStream"]>[0]) {
    const state = readRunState(input.chatId);
    if (!state || isTerminal(state.status) || state.status === "paused") return null;
    const client = createOpenCompanyClient(this.baseUrl(), { fetch: this.apiFetchImpl });
    const response = await client.v1.runs[":runId"].$get({ param: { runId: state.runId } });
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
    const client = createOpenCompanyClient(this.baseUrl(), { fetch: this.apiFetchImpl });
    const response = await client.v1.runs[":runId"].cancel.$post({
      param: { runId: state.runId },
    });
    if (!response.ok) throw await responseError(response);
    state.status = (await response.json()).data.status;
    writeRunStateAliases(chatId, state);
    return true;
  }

  private async continueApproval(chatId: string, message: UI_MESSAGE, signal?: AbortSignal) {
    let state = readRunState(chatId);
    const metadata = messageMetadata(message);
    if (!state && metadata.runId && metadata.sessionId) {
      const client = createOpenCompanyClient(this.baseUrl(), { fetch: this.apiFetchImpl });
      const response = await client.v1.runs[":runId"].$get({
        param: { runId: metadata.runId },
      });
      if (response.ok) {
        const run = (await response.json()).data;
        state = {
          runId: run.id,
          conversationId: run.conversationId,
          assistantMessageId: message.id,
          model: metadata.model ?? run.model,
          content: textFromMessage(message),
          status: run.status,
        };
        writeRunStateAliases(chatId, state);
      }
    }
    if (!state) throw new Error("The durable Run for this approval is no longer available.");
    const approvals = approvalResponses(message);
    if (approvals.length === 0) throw new Error("An approval response is required.");
    const client = createOpenCompanyClient(this.baseUrl(), { fetch: this.apiFetchImpl });
    for (const approval of approvals) {
      const response = await client.v1.runs[":runId"].approvals[":approvalId"].$post(
        {
          param: { runId: state.runId, approvalId: approval.id },
          json: { resolution: approval.approved ? "approved" : "denied" },
        },
        signal ? { init: { signal } } : undefined,
      );
      if (!response.ok) throw await responseError(response);
    }
    state.status = "queued";
    writeRunStateAliases(chatId, state);
    return this.uiStream(chatId, state, signal, true);
  }

  private uiStream(
    chatId: string,
    initialState: HeadlessRunState,
    signal?: AbortSignal,
    continuation = false,
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
          state.startedToolCallIds,
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
        if (continuation) controller.enqueue({ type: "start-step" });
        try {
          for await (const event of streamRunEvents({
            baseUrl,
            runId: state.runId,
            ...(state.cursor ? { cursor: state.cursor } : {}),
            ...(state.presentationCursor ? { presentationCursor: state.presentationCursor } : {}),
            ...(signal ? { signal } : {}),
            fetch: fetchImpl,
            onCursor(cursor) {
              state.cursor = cursor;
              writeRunStateAliases(chatId, state);
            },
            onPresentationCursor(cursor) {
              state.presentationCursor = cursor;
              writeRunStateAliases(chatId, state);
            },
          })) {
            for (const chunk of projector.project(event)) controller.enqueue(chunk);
            state.content = projector.content;
            state.textSegment = projector.segment;
            state.startedToolCallIds = projector.startedToolCallIds;
            if (event.type !== "message.presentation_delta") {
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
            controller.enqueue({ type: "abort", reason: "Disconnected from the Run stream." });
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
  const apiFetchImpl = createHeadlessChatApiFetch({ baseUrl, fetch: fetchImpl });
  const client = createOpenCompanyClient(baseUrl, { fetch: apiFetchImpl });
  const response = await client.v1.messages.$post({
    header: { "idempotency-key": idempotencyKey(input.clientMessageId) },
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
  await awaitHeadlessChatTransaction({
    conversationId: data.conversationId,
    transactionId: data.transactionId,
  });
  // Background Chat has no mounted useChat consumer, so consume semantic events until the Run
  // settles or pauses for user interaction.
  for await (const event of streamRunEvents({
    baseUrl,
    runId: data.runId,
    fetch: apiFetchImpl,
  })) {
    // Event projection and presentation are owned by Postgres/Electric; no transient UI overlay.
    void event;
  }
  return data;
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

function approvalResponses(message: UIMessage) {
  const responses: Array<{ id: string; approved: boolean }> = [];
  for (const part of message.parts) {
    if (!part || typeof part !== "object" || !("state" in part) || !("approval" in part)) continue;
    if (part.state !== "approval-responded") continue;
    const approval = part.approval;
    if (!approval || typeof approval !== "object") continue;
    if (!("id" in approval) || typeof approval.id !== "string") continue;
    if (!("approved" in approval) || typeof approval.approved !== "boolean") continue;
    responses.push({ id: approval.id, approved: approval.approved });
  }
  return responses;
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
    if (!value || typeof value !== "object") return null;
    const state = value as Partial<HeadlessRunState>;
    if (!state.runId || !state.conversationId || !state.assistantMessageId || !state.status) {
      return null;
    }
    return state as HeadlessRunState;
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

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
