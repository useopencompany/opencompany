import { captureException } from "@opencompany/observability";
import { PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@opencompany/protocol";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitHeadlessChatTransaction } from "./headless-chat-collections";
import { HeadlessChatTransport, startHeadlessBackgroundChat } from "./headless-chat-transport";

vi.mock("./headless-chat-collections", () => ({
  awaitHeadlessChatTransaction: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
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
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    vi.mocked(awaitHeadlessChatTransaction).mockReset().mockResolvedValue(undefined);
    vi.mocked(captureException).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends Auto to the canonical API and adopts its authoritative model", async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = requestUrl(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ path: url.pathname, ...(body ? { body } : {}) });
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
              model: "moonshotai/kimi-k2.6",
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

    const chunks = await collect(
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

    expect(requests.slice(0, 1)).toEqual([
      {
        path: "/v1/messages",
        body: expect.objectContaining({ model: "auto" }),
      },
    ]);
    expect(chunks[0]).toMatchObject({
      type: "start",
      messageMetadata: { model: "moonshotai/kimi-k2.6" },
    });
  });

  it("binds the default browser fetch while routing and streaming a canonical Run", async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn(function (this: unknown, input: URL | RequestInfo, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      const url = requestUrl(input);
      paths.push(url.pathname);
      if (url.pathname === "/v1/messages") {
        return Promise.resolve(
          Response.json(
            {
              data: {
                conversationId: "conversation_bound",
                messageId: "message_bound",
                assistantMessageId: "assistant_bound",
                runId: "run_bound",
                transactionId: "44",
                replayed: false,
                model: "moonshotai/kimi-k2.6",
              },
              meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
            },
            { status: 202 },
          ),
        );
      }
      if (url.pathname.endsWith("/events")) {
        return Promise.resolve(
          sse([
            {
              ...event(1, "run.completed", { messageId: "assistant_bound" }),
              runId: "run_bound",
            },
          ]),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HeadlessChatTransport<UIMessage>({
      baseUrl: "https://app.example.test",
    });

    await collect(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "conversation_bound",
        messageId: undefined,
        messages: [
          {
            id: "message_bound",
            role: "user",
            parts: [{ type: "text", text: "Route this" }],
          },
        ],
        body: { newSessionId: "conversation_bound", model: "auto" },
        abortSignal: undefined,
      }),
    );

    expect(paths).toEqual(["/v1/messages", "/v1/runs/run_bound/events"]);
  });

  it("creates a durable Run and translates validated semantic events into AI SDK chunks", async () => {
    let createBody: Record<string, unknown> | null = null;
    let idempotencyKey = "";
    let protocolVersion = "";
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/messages") {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        idempotencyKey = headers.get("idempotency-key") ?? "";
        protocolVersion = headers.get(PROTOCOL_VERSION_HEADER) ?? "";
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
          event(4, "tool.started", {
            toolCallId: "tool_1",
            name: "use_action",
          }),
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
      engine: { type: "opencompany", schemaVersion: 1 },
      model: "model_1",
      attachmentIds: ["attachment_1"],
      mentions: [{ kind: "skill", id: "skill_1" }],
    });
    expect(idempotencyKey).toBe("web-message:ui_message_1");
    expect(protocolVersion).toBe(PROTOCOL_VERSION);
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation_1",
        transactionId: "42",
      }),
    );
    await vi.waitFor(() =>
      expect(reconciled).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conversation_1",
          transactionId: "42",
        }),
      ),
    );
    expect(awaitHeadlessChatTransaction).toHaveBeenCalledWith({
      conversationId: "conversation_1",
      transactionId: "42",
    });
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "start",
          messageId: "message_assistant_1",
        }),
        {
          type: "text-delta",
          id: "text_message_assistant_1_1",
          delta: "Working",
        },
        expect.objectContaining({
          type: "tool-input-available",
          toolCallId: "tool_1",
        }),
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
    const replayQueries: Array<{
      durable: string | null;
      presentation: string | null;
    }> = [];
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
      { type: "text-delta", id: "text_message_assistant_1_1", delta: "Hello" },
      { type: "text-delta", id: "text_message_assistant_1_1", delta: " world" },
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
      if (url.pathname === "/v1/runs/run_1") {
        return Response.json({
          data: {
            id: "run_1",
            conversationId: "conversation_1",
            triggerMessageId: "message_user_1",
            status: "queued",
            engine: "opencompany",
            model: "model_1",
            attemptCount: 1,
            createdAt: occurredAt,
            updatedAt: occurredAt,
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
    await transport.resolveApproval({
      chatId: "chat_1",
      approvalId: "approval_1",
      approved: true,
    });
    const resumed = await transport.reconnectToStream({ chatId: "chat_1" });
    expect(resumed).not.toBeNull();
    const chunks = await collect(resumed!);
    expect(eventCursors).toEqual([null, "v1:3"]);
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-input-available",
          toolCallId: "tool_1",
          toolName: "use_action",
        }),
        {
          type: "text-delta",
          id: "text_message_assistant_1_2",
          delta: " done",
        },
        expect.objectContaining({ type: "finish", finishReason: "stop" }),
      ]),
    );
  });

  it("rehydrates an active tool invocation before consuming its result after reconnect", async () => {
    const toolCallId = "tool_reconnected_1";
    sessionStorage.setItem(
      "opencompany:headless-chat:v1:conversation_1",
      JSON.stringify({
        checkpointVersion: 2,
        runId: "run_1",
        conversationId: "conversation_1",
        assistantMessageId: "message_assistant_1",
        model: "model_1",
        activeToolCalls: [{ toolCallId, toolName: "brain_search", input: {} }],
        cursor: "v1:1",
        status: "running",
      }),
    );
    const eventCursors: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/runs/run_1") return runResponse("running");
      if (url.pathname.endsWith("/events")) {
        eventCursors.push(url.searchParams.get("cursor"));
        return sse([
          event(2, "tool.completed", { toolCallId }),
          event(3, "run.completed", { messageId: "message_assistant_1" }),
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const transport = new HeadlessChatTransport<UIMessage>({
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
    });

    const resumed = await transport.reconnectToStream({
      chatId: "conversation_1",
    });
    expect(resumed).not.toBeNull();
    const { message, errors } = await consumeUiMessage(resumed!);

    expect(eventCursors).toEqual(["v1:1"]);
    expect(errors).toEqual([]);
    expect(
      message?.parts.find((part) => "toolCallId" in part && part.toolCallId === toolCallId),
    ).toMatchObject({
      type: "tool-brain_search",
      toolCallId,
      state: "output-available",
      output: { ok: true },
    });
  });

  it("replays legacy checkpoints from the beginning to rebuild tool state safely", async () => {
    const toolCallId = "tool_reconnected_1";
    sessionStorage.setItem(
      "opencompany:headless-chat:v1:conversation_1",
      JSON.stringify({
        runId: "run_1",
        conversationId: "conversation_1",
        assistantMessageId: "message_assistant_1",
        model: "model_1",
        content: "",
        textSegment: 0,
        startedToolCallIds: [toolCallId],
        cursor: "v1:1",
        status: "running",
      }),
    );
    const eventCursors: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/runs/run_1") return runResponse("running");
      if (url.pathname.endsWith("/events")) {
        eventCursors.push(url.searchParams.get("cursor"));
        return sse([
          event(1, "tool.started", { toolCallId, name: "brain_search" }),
          event(2, "tool.completed", { toolCallId }),
          event(3, "run.completed", { messageId: "message_assistant_1" }),
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const transport = new HeadlessChatTransport<UIMessage>({
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
    });

    const resumed = await transport.reconnectToStream({
      chatId: "conversation_1",
    });
    expect(resumed).not.toBeNull();
    const { message, errors } = await consumeUiMessage(resumed!);

    expect(eventCursors).toEqual([null]);
    expect(errors).toEqual([]);
    expect(
      message?.parts.find((part) => "toolCallId" in part && part.toolCallId === toolCallId),
    ).toMatchObject({
      type: "tool-brain_search",
      toolCallId,
      state: "output-available",
    });
  });

  it("does not advance a checkpoint past an event that cannot be projected", async () => {
    sessionStorage.setItem(
      "opencompany:headless-chat:v1:conversation_1",
      JSON.stringify({
        checkpointVersion: 2,
        runId: "run_1",
        conversationId: "conversation_1",
        assistantMessageId: "message_assistant_1",
        model: "model_1",
        activeToolCalls: [],
        cursor: "v1:1",
        status: "running",
      }),
    );
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/runs/run_1") return runResponse("running");
      if (url.pathname.endsWith("/events")) {
        return sse([event(2, "tool.completed", { toolCallId: "tool_missing" })]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const transport = new HeadlessChatTransport<UIMessage>({
      baseUrl: "https://app.example.test",
      fetch: fetchMock as typeof fetch,
    });

    const resumed = await transport.reconnectToStream({
      chatId: "conversation_1",
    });
    expect(resumed).not.toBeNull();
    await expect(collect(resumed!)).rejects.toThrow(
      "tool.completed was received before tool.started for tool call tool_missing.",
    );
    expect(
      JSON.parse(sessionStorage.getItem("opencompany:headless-chat:v1:conversation_1") ?? "null"),
    ).toMatchObject({ cursor: "v1:1", activeToolCalls: [] });
  });

  it("recovers a paused approval without session storage and reconnects to its Run", async () => {
    let runGets = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/runs/run_1") {
        runGets += 1;
        return Response.json({
          data: {
            id: "run_1",
            conversationId: "conversation_1",
            triggerMessageId: "message_user_1",
            status: runGets === 1 ? "paused" : "queued",
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
    await transport.resolveApproval({
      chatId: "conversation_1",
      approvalId: "approval_1",
      approved: true,
      runId: "run_1",
      assistantMessageId: "message_assistant_1",
      model: "model_1",
    });
    const resumed = await transport.reconnectToStream({
      chatId: "conversation_1",
    });
    expect(resumed).not.toBeNull();
    const chunks = await collect(resumed!);

    expect(chunks.filter((chunk) => chunk.type === "text-delta")).toEqual([
      {
        type: "text-delta",
        id: "text_message_assistant_1_1",
        delta: "Working",
      },
      { type: "text-delta", id: "text_message_assistant_1_2", delta: " done" },
    ]);
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({ type: "finish", finishReason: "stop" }),
    );
  });

  it("waits for a background Run to settle through the shared semantic event stream", async () => {
    const paths: string[] = [];
    let protocolVersion = "";
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = requestUrl(input);
      paths.push(url.pathname);
      if (url.pathname === "/v1/messages") {
        protocolVersion = new Headers(init?.headers).get(PROTOCOL_VERSION_HEADER) ?? "";
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
            ...event(1, "run.completed", {
              messageId: "message_assistant_background",
            }),
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
        {
          baseUrl: "https://app.example.test",
          fetch: fetchMock as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ runId: "run_background" });
    expect(paths).toEqual(["/v1/messages", "/v1/runs/run_background/events"]);
    expect(protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("keeps an accepted background Run alive when read-model reconciliation times out", async () => {
    const paths: string[] = [];
    const timeout = new Error(
      "[headless-chat:messages:v1:conversation_background] Timeout waiting for txId: 42",
    );
    vi.mocked(awaitHeadlessChatTransaction).mockRejectedValueOnce(timeout);
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
            ...event(1, "run.completed", {
              messageId: "message_assistant_background",
            }),
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
        {
          baseUrl: "https://app.example.test",
          fetch: fetchMock as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ runId: "run_background" });

    expect(paths).toEqual(["/v1/messages", "/v1/runs/run_background/events"]);
    await vi.waitFor(() =>
      expect(captureException).toHaveBeenCalledWith(timeout, {
        event: "opencompany.chat_read_model_reconciliation_failed",
        session_id: "conversation_background",
        run_id: "run_background",
        message_id: "message_assistant_background",
        transaction_id: "42",
      }),
    );
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

async function consumeUiMessage(stream: ReadableStream<UIMessageChunk>) {
  const errors: unknown[] = [];
  let message: UIMessage | undefined;
  for await (const value of readUIMessageStream<UIMessage>({
    stream,
    terminateOnError: true,
    onError: (error) => errors.push(error),
  })) {
    message = value;
  }
  return { message, errors };
}

function runResponse(status: "queued" | "running" | "paused" | "completed") {
  return Response.json({
    data: {
      id: "run_1",
      conversationId: "conversation_1",
      triggerMessageId: "message_user_1",
      status,
      engine: "opencompany",
      model: "model_1",
      attemptCount: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
    meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
  });
}
