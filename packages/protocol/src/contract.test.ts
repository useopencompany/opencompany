import { describe, expect, it } from "vitest";
import {
  createOpenCompanyClient,
  formatEventCursor,
  parseEventCursor,
  parseRunEvent,
  parseRunStreamEvent,
} from "./client";
import { createOpenApiDocument } from "./routes";
import { CreateMessageBodySchema, ErrorEnvelopeSchema } from "./schemas";

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
        meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
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
