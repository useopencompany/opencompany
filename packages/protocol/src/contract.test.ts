import { describe, expect, it } from "vitest";
import {
  createOpenCompanyClient,
  formatEventCursor,
  parseEventCursor,
  parseRunEvent,
  parseRunStreamEvent,
} from "./client";
import { createOpenApiDocument } from "./routes";
import {
  CreateMessageBodySchema,
  ErrorEnvelopeSchema,
  MessagePartSchema,
  MessageSchema,
} from "./schemas";

describe("v1 protocol contract", () => {
  it("validates canonical Message commands without accepting legacy physical vocabulary", () => {
    expect(
      CreateMessageBodySchema.parse({
        clientConversationId: "conversation_1",
        clientMessageId: "message_1",
        content: "Hello",
        engine: "opencompany",
      }),
    ).toMatchObject({ content: "Hello", engine: "opencompany" });

    expect(() =>
      CreateMessageBodySchema.parse({
        sessionId: "legacy_session",
        turnId: "legacy_turn",
        userWorkosId: "provider_identity",
        content: "Hello",
      }),
    ).toThrow();
  });

  it("uses structured versioned errors", () => {
    expect(
      ErrorEnvelopeSchema.parse({
        error: {
          code: "idempotency_conflict",
          message: "The key was already used for another command.",
          requestId: "request_1",
          retryable: false,
        },
        meta: { apiVersion: "v1", protocolVersion: "1.1.0" },
      }),
    ).toMatchObject({ error: { code: "idempotency_conflict" } });
  });

  it("parses typed semantic events and rejects provider or lease payload leakage", () => {
    const event = parseRunEvent({
      schemaVersion: 1,
      id: "event_1",
      cursor: "v1:7",
      runId: "run_1",
      attemptId: "attempt_1",
      occurredAt: "2026-08-10T20:00:00.000Z",
      type: "message.content_updated",
      payload: { messageId: "message_2", content: "Done", complete: true },
    });
    expect(event.type).toBe("message.content_updated");

    expect(() =>
      parseRunEvent({
        ...event,
        leaseId: "lease_1",
        payload: { ...event.payload, providerResponse: { secret: true } },
      }),
    ).toThrow();
  });

  it("uses a versioned per-Run sequence cursor", () => {
    expect(formatEventCursor(42)).toBe("v1:42");
    expect(parseEventCursor("v1:42")).toBe(42);
    expect(parseEventCursor(undefined)).toBe(0);
    expect(() => parseEventCursor("42")).toThrow();
  });

  it("validates transient presentation deltas separately from durable cursors", () => {
    const event = parseRunStreamEvent({
      runId: "run_1",
      attemptNumber: 2,
      presentationCursor: "p1:1786449600000-3",
      schemaVersion: 1,
      occurredAt: "2026-08-11T10:00:00.000Z",
      type: "message.presentation_delta",
      payload: {
        messageId: "message_2",
        partId: "part_1",
        kind: "text",
        startOffset: 5,
        endOffset: 11,
        delta: " world",
      },
    });
    expect(event.type).toBe("message.presentation_delta");
    expect(event).not.toHaveProperty("cursor");
    expect(event).not.toHaveProperty("id");
    expect(() =>
      parseRunStreamEvent({
        ...event,
        payload: { ...event.payload, endOffset: 12 },
      }),
    ).toThrow(/offsets/u);
  });

  it("streams a typed, ordered reasoning part alongside text and rejects provider metadata leakage", () => {
    const event = parseRunEvent({
      schemaVersion: 1,
      id: "event_2",
      cursor: "v1:8",
      runId: "run_1",
      attemptId: "attempt_1",
      occurredAt: "2026-08-11T10:00:00.000Z",
      type: "message.part_updated",
      payload: {
        messageId: "message_2",
        partId: "reasoning_message_2_0",
        kind: "reasoning",
        order: 0,
        state: "streaming",
        text: "Checking the launch date",
      },
    });
    expect(event.type).toBe("message.part_updated");

    expect(() =>
      parseRunEvent({
        ...event,
        payload: { ...event.payload, providerMetadata: { hidden: "chain-of-thought" } },
      }),
    ).toThrow();

    const message = MessageSchema.parse({
      id: "message_2",
      conversationId: "conversation_1",
      role: "assistant",
      content: "It is Friday.",
      parts: [
        {
          type: "reasoning",
          id: "reasoning_message_2_0",
          order: 0,
          text: "Checking the launch date",
          state: "done",
        },
        { type: "text", id: "text_message_2_1", order: 1, text: "It is Friday.", state: "done" },
        {
          type: "tool",
          id: "tool_call_1",
          order: 2,
          toolName: "goat_brain",
          state: "output-available",
          input: { command: "query" },
          output: { ok: true },
        },
      ],
      attachments: [],
      createdAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T10:00:01.000Z",
    });
    expect(message.parts.map((part: { type: string }) => part.type)).toEqual([
      "reasoning",
      "text",
      "tool",
    ]);

    // Raw provider fields must never cross the typed boundary, even if a caller tries to smuggle
    // them onto an otherwise-valid part.
    expect(() =>
      MessagePartSchema.parse({
        type: "tool",
        id: "tool_call_1",
        order: 0,
        toolName: "goat_brain",
        state: "output-available",
        callProviderMetadata: { gateway: { callId: "call_1" } },
      }),
    ).toThrow();
  });

  it("generates OpenAPI from the same schemas and exposes the typed Hono client", () => {
    const document = createOpenApiDocument();
    expect(Object.keys(document.paths ?? {})).toEqual([
      "/v1/conversations",
      "/v1/conversations/{conversationId}",
      "/v1/conversations/{conversationId}/messages",
      "/v1/messages",
      "/v1/attachments",
      "/v1/runs/{runId}",
      "/v1/runs/{runId}/events",
      "/v1/runs/{runId}/cancel",
      "/v1/runs/{runId}/approvals/{approvalId}",
      "/v1/read-models/{readModel}",
    ]);
    expect(JSON.stringify(document)).not.toMatch(/workos|codex_chat_turn|lease_owner/iu);

    const client = createOpenCompanyClient("https://api.opencompany.test");
    expect(
      client.v1.runs[":runId"].events.$url({ param: { runId: "run_1" }, query: {} }).pathname,
    ).toBe("/v1/runs/run_1/events");
  });
});
