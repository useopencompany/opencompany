import type { UIMessage, UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitHeadlessChatTransaction } from "./headless-chat-collections";
import { HeadlessChatTransport, startHeadlessBackgroundChat } from "./headless-chat-transport";

vi.mock("./headless-chat-collections", () => ({
  awaitHeadlessChatTransaction: vi.fn(async () => undefined),
}));

const occurredAt = "2026-08-10T20:00:00.000Z";

function event(sequence: number, type: string, payload: Record<string, unknown>) {
  return {
    id: `event_${sequence}`,
    runId: "run_1",
    attemptId: "attempt_1",
    cursor: `v1:${sequence}`,
    schemaVersion: 1,
    occurredAt,
    type,
    payload,
  };
}

function presentationEvent(presentationCursor: string, delta: string, startOffset: number) {
  return {
    runId: "run_1",
    attemptNumber: 1,
    presentationCursor,
    schemaVersion: 1,
    occurredAt,
    type: "message.presentation_delta",
    payload: {
      messageId: "message_assistant_1",
      startOffset,
      endOffset: startOffset + delta.length,
      delta,
    },
  };
}

function sse(events: unknown[]) {
  return new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  get length() {
    return this.values.size;
  }
}

describe("canonical Chat transport", () => {
  beforeEach(() => vi.stubGlobal("sessionStorage", new MemoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("resolves Auto on the authenticated web host before creating the canonical Run", async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = requestUrl(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ path: url.pathname, ...(body ? { body } : {}) });
      if (url.pathname === "/api/chat/model-route") {
        return Response.json({ model: "moonshotai/kimi-k2.6", tier: "fast" });
      }
      if (url.pathname === "/v1/messages") {
        return Response.json(
          {
            data: {
              conversationId: "conversation_auto",
              messageId: "message_auto",
              assistantMessageId: "assistant_auto",
              runId: "run_auto",
              transactionId: "43",
              replayed: false,
            },
            meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
          },
          { status: 202 },
        );
      }
      if (url.pathname.endsWith("/events")) {
        return sse([
          {
            ...event(1, "run.completed", { messageId: "assistant_auto" }),
            runId: "run_auto",
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const transport = new HeadlessChatTransport<UIMessage>({
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
    });

    await collect(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "conversation_auto",
        messageId: undefined,
        messages: [
          {
            id: "message_auto",
            role: "user",
            parts: [{ type: "text", text: "Route this" }],
            metadata: { attachments: [{ id: "attachment_auto" }] },
          },
        ],
        body: { newSessionId: "conversation_auto", model: "auto" },
        abortSignal: undefined,
      }),
    );

    expect(requests.slice(0, 2)).toEqual([
      {
        path: "/api/chat/model-route",
        body: {
          clientMessageId: "message_auto",
          prompt: "Route this",
          attachmentIds: ["attachment_auto"],
        },
      },
      {
        path: "/v1/messages",
        body: expect.objectContaining({ model: "moonshotai/kimi-k2.6" }),
      },
    ]);
  });

  it("creates a durable Run and translates validated semantic events into AI SDK chunks", async () => {
    let createBody: Record<string, unknown> | null = null;
    let idempotencyKey = "";
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/messages") {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        idempotencyKey = new Headers(init?.headers).get("idempotency-key") ?? "";
        return Response.json(
          {
            data: {
              conversationId: "conversation_1",
              messageId: "message_user_1",
              assistantMessageId: "message_assistant_1",
              runId: "run_1",
              transactionId: "42",
              replayed: false,
            },
            meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
          },
          { status: 202 },
        );
      }
      if (url.pathname.endsWith("/events")) {
        return sse([
          event(1, "run.queued", {
            conversationId: "conversation_1",
            triggerMessageId: "message_user_1",
          }),
          event(2, "run.started", { attemptNumber: 1 }),
          event(3, "message.content_updated", {
            messageId: "message_assistant_1",
            content: "Working",
            complete: false,
          }),
          event(4, "tool.started", { toolCallId: "tool_1", name: "use_action" }),
          event(5, "approval.requested", {
            approvalId: "approval_1",
            toolCallId: "tool_1",
            kind: "use_action",
            prompt: "Approve crm.update?",
            options: ["approved", "denied"],
          }),
          event(6, "run.paused", { reason: "approval_required" }),
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const accepted = vi.fn();
    const reconciled = vi.fn();
    const transport = new HeadlessChatTransport<UIMessage>({
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
      onAccepted: accepted,
      onReconciled: reconciled,
    });
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "optimistic_conversation_1",
      messageId: undefined,
      messages: [
        {
          id: "ui_message_1",
          role: "user",
          parts: [{ type: "text", text: "Update the account" }],
          metadata: {
            attachments: [{ id: "attachment_1" }],
            mentions: [{ kind: "skill", id: "skill_1" }],
          },
        },
      ],
      body: { newSessionId: "optimistic_conversation_1", model: "model_1" },
      abortSignal: undefined,
    });
    const chunks = await collect(stream);

    expect(createBody).toMatchObject({
      clientConversationId: "optimistic_conversation_1",
      clientMessageId: "ui_message_1",
      content: "Update the account",
      engine: "opencompany",
      model: "model_1",
      attachmentIds: ["attachment_1"],
      mentions: [{ kind: "skill", id: "skill_1" }],
    });
    expect(idempotencyKey).toBe("web-message:ui_message_1");
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conversation_1", transactionId: "42" }),
    );
    await vi.waitFor(() =>
      expect(reconciled).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: "conversation_1", transactionId: "42" }),
      ),
    );
    expect(awaitHeadlessChatTransaction).toHaveBeenCalledWith({
      conversationId: "conversation_1",
      transactionId: "42",
    });
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "start", messageId: "message_assistant_1" }),
        { type: "text-delta", id: "text_message_assistant_1", delta: "Working" },
        expect.objectContaining({ type: "tool-input-available", toolCallId: "tool_1" }),
        {
          type: "tool-approval-request",
          approvalId: "approval_1",
          toolCallId: "tool_1",
        },
        expect.objectContaining({ type: "finish", finishReason: "tool-calls" }),
      ]),
    );
  });

  it("replays offset deltas without duplicating content across a reconnect", async () => {
    let eventRequests = 0;
    const replayQueries: Array<{ durable: string | null; presentation: string | null }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/messages") {
        return Response.json(
          {
            data: {
              conversationId: "conversation_1",
              messageId: "message_user_1",
              assistantMessageId: "message_assistant_1",
              runId: "run_1",
              transactionId: "42",
              replayed: false,
            },
            meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
          },
          { status: 202 },
        );
      }
      if (url.pathname.endsWith("/events")) {
        eventRequests += 1;
        replayQueries.push({
          durable: url.searchParams.get("cursor"),
          presentation: url.searchParams.get("presentationCursor"),
        });
        return eventRequests === 1
          ? sse([presentationEvent("p1:1786449600000-0", "Hello", 0)])
          : sse([
              event(1, "message.content_updated", {
                messageId: "message_assistant_1",
                content: "Hel",
                complete: false,
              }),
              presentationEvent("p1:1786449600050-0", " world", 5),
              presentationEvent("p1:1786449600100-0", "Hello", 0),
              event(2, "message.content_updated", {
                messageId: "message_assistant_1",
                content: "Hello world",
                complete: true,
              }),
              event(3, "run.completed", { messageId: "message_assistant_1" }),
            ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const transport = new HeadlessChatTransport<UIMessage>({
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
    });
    const chunks = await collect(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "conversation_1",
        messageId: undefined,
        messages: [{ id: "user_1", role: "user", parts: [{ type: "text", text: "Go" }] }],
        abortSignal: undefined,
      }),
    );

    expect(chunks.filter((chunk) => chunk.type === "text-delta")).toEqual([
      { type: "text-delta", id: "text_message_assistant_1", delta: "Hello" },
      { type: "text-delta", id: "text_message_assistant_1", delta: " world" },
    ]);
    expect(replayQueries).toEqual([
      { durable: null, presentation: null },
      { durable: null, presentation: "p1:1786449600000-0" },
    ]);
  });

  it("resolves an approval on the same Run and reconnects from its durable cursor", async () => {
    const eventCursors: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/messages") {
        return Response.json(
          {
            data: {
              conversationId: "conversation_1",
              messageId: "message_user_1",
              assistantMessageId: "message_assistant_1",
              runId: "run_1",
              transactionId: "42",
              replayed: false,
            },
            meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
          },
          { status: 202 },
        );
      }
      if (url.pathname.endsWith("/approvals/approval_1")) {
        return Response.json({
          data: {
            approvalId: "approval_1",
            runId: "run_1",
            resolution: "approved",
            replayed: false,
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        });
      }
      if (url.pathname.endsWith("/events")) {
        eventCursors.push(url.searchParams.get("cursor"));
        return eventCursors.length === 1
          ? sse([
              event(1, "message.content_updated", {
                messageId: "message_assistant_1",
                content: "Working",
                complete: true,
              }),
              event(2, "approval.requested", {
                approvalId: "approval_1",
                toolCallId: "tool_1",
                kind: "use_action",
                prompt: "Approve?",
              }),
              event(3, "run.paused", { reason: "approval_required" }),
            ])
          : sse([
              event(4, "message.content_updated", {
                messageId: "message_assistant_1",
                content: "Working done",
                complete: true,
              }),
              event(5, "run.completed", { messageId: "message_assistant_1" }),
            ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const transport = new HeadlessChatTransport<UIMessage>({
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
    });
    await collect(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat_1",
        messageId: undefined,
        messages: [{ id: "user_1", role: "user", parts: [{ type: "text", text: "Go" }] }],
        abortSignal: undefined,
      }),
    );
    const chunks = await collect(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat_1",
        messageId: undefined,
        messages: [
          {
            id: "message_assistant_1",
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolName: "use_action",
                toolCallId: "tool_1",
                input: {},
                state: "approval-responded",
                approval: { id: "approval_1", approved: true },
              },
            ],
          } as UIMessage,
        ],
        abortSignal: undefined,
      }),
    );
    expect(eventCursors).toEqual([null, "v1:3"]);
    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: "text-delta", id: "text_message_assistant_1", delta: " done" },
        expect.objectContaining({ type: "finish", finishReason: "stop" }),
      ]),
    );
  });

  it("recovers a paused approval without session storage and suppresses persisted content", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/runs/run_1") {
        return Response.json({
          data: {
            id: "run_1",
            conversationId: "conversation_1",
            triggerMessageId: "message_user_1",
            status: "paused",
            engine: "opencompany",
            model: "model_1",
            attemptCount: 1,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        });
      }
      if (url.pathname.endsWith("/approvals/approval_1")) {
        return Response.json({
          data: {
            approvalId: "approval_1",
            runId: "run_1",
            resolution: "approved",
            replayed: false,
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        });
      }
      if (url.pathname.endsWith("/events")) {
        return sse([
          event(1, "message.content_updated", {
            messageId: "message_assistant_1",
            content: "Working",
            complete: true,
          }),
          event(2, "run.paused", { reason: "approval_required" }),
          event(3, "approval.resolved", {
            approvalId: "approval_1",
            resolution: "approved",
          }),
          event(4, "message.content_updated", {
            messageId: "message_assistant_1",
            content: "Working done",
            complete: true,
          }),
          event(5, "run.completed", { messageId: "message_assistant_1" }),
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const transport = new HeadlessChatTransport<UIMessage>({
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
    });
    const chunks = await collect(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "conversation_1",
        messageId: undefined,
        messages: [
          {
            id: "message_assistant_1",
            role: "assistant",
            metadata: { sessionId: "conversation_1", runId: "run_1", model: "model_1" },
            parts: [
              { type: "text", text: "Working", state: "done" },
              {
                type: "dynamic-tool",
                toolName: "use_action",
                toolCallId: "tool_1",
                input: {},
                state: "approval-responded",
                approval: { id: "approval_1", approved: true },
              },
            ],
          } as UIMessage,
        ],
        abortSignal: undefined,
      }),
    );

    expect(chunks.filter((chunk) => chunk.type === "text-delta")).toEqual([
      { type: "text-delta", id: "text_message_assistant_1", delta: " done" },
    ]);
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({ type: "finish", finishReason: "stop" }),
    );
  });

  it("waits for a background Run to settle through the shared semantic event stream", async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      paths.push(url.pathname);
      if (url.pathname === "/v1/messages") {
        return Response.json(
          {
            data: {
              conversationId: "conversation_background",
              messageId: "message_background",
              assistantMessageId: "message_assistant_background",
              runId: "run_background",
              transactionId: "42",
              replayed: false,
            },
            meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
          },
          { status: 202 },
        );
      }
      if (url.pathname.endsWith("/events")) {
        return sse([
          {
            ...event(1, "run.completed", { messageId: "message_assistant_background" }),
            runId: "run_background",
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(
      startHeadlessBackgroundChat(
        {
          content: "Work in the background",
          clientConversationId: "conversation_background",
          clientMessageId: "message_background",
          model: "model_1",
        },
        { baseUrl: "https://app.example.test", fetch: fetchMock as typeof fetch },
      ),
    ).resolves.toMatchObject({ runId: "run_background" });
    expect(paths).toEqual(["/v1/messages", "/v1/runs/run_background/events"]);
  });
});

function requestUrl(input: URL | RequestInfo) {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

async function collect(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
