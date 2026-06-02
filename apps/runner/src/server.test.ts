import { createSessionStreamToken } from "@opencompany/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedRuntimeEvent, RuntimeEventForStream } from "./events";
import { enqueueRunnerJob } from "./jobs";
import {
  createServer,
  createSseHeaders,
  formatSseEvent,
  formatStreamError,
  redactStreamToken,
} from "./server";

vi.mock("./agent-loop", () => ({
  abortSession: vi.fn(async () => undefined),
  archiveSession: vi.fn(async () => undefined),
}));

vi.mock("./jobs", () => ({
  enqueueRunnerJob: vi.fn(async () => ({
    id: 1,
    status: "pending",
  })),
}));

const env = {
  databaseUrl: "postgres://example",
  internalToken: "internal-secret",
  streamTokenSecret: "stream-secret",
  e2bApiKey: "e2b",
  vercelAiGatewayApiKey: "gateway",
  exaApiKey: undefined,
  xApiBearerToken: undefined,
  supadataApiKey: undefined,
  ampApiKey: undefined,
  e2bTemplate: undefined,
  ampE2bTemplate: undefined,
  e2bSandboxIdleTimeoutMs: 30_000,
  port: 3040,
  allowedOrigins: ["https://app.example.com"],
  instanceId: "runner-test",
};

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
  vi.clearAllMocks();
});

describe("runner server CORS", () => {
  it("allows configured origins", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "https://app.example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(response.headers.vary).toBe("Origin");
  });

  it("does not set CORS headers for unexpected origins", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "https://evil.example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("session event stream auth", () => {
  it("rejects missing stream tokens with 401", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/sessions/ses_123/events",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Missing stream token." });
  });

  it("rejects invalid stream tokens with 401", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/sessions/ses_123/events?token=bad-token",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid stream token." });
  });

  it("rejects tokens minted for a different session with 403", async () => {
    const server = createServer(env);
    servers.push(server);
    const token = createSessionStreamToken(
      { sessionId: "ses_other", userId: "usr_123", expiresAt: Date.now() + 60_000 },
      env.streamTokenSecret,
    );

    const response = await server.inject({
      method: "GET",
      url: `/sessions/ses_123/events?token=${encodeURIComponent(token)}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Token does not match session." });
  });
});

describe("internal session start endpoint", () => {
  it("persists a runner job before accepting authenticated start requests", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/sessions/ses_123/start",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(enqueueRunnerJob).toHaveBeenCalledWith({
      kind: "start",
      sessionId: "ses_123",
    });
  });
});

describe("internal message run endpoint", () => {
  it("persists a runner job before accepting authenticated message requests", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/sessions/ses_123/messages/msg_123/run",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(enqueueRunnerJob).toHaveBeenCalledWith({
      kind: "message",
      sessionId: "ses_123",
      messageId: "msg_123",
    });
  });
});

describe("internal session title endpoint", () => {
  it("accepts authenticated title generation requests", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/sessions/ses_123/messages/msg_123/title",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(enqueueRunnerJob).toHaveBeenCalledWith({
      kind: "title",
      sessionId: "ses_123",
      messageId: "msg_123",
    });
  });
});

describe("internal after-session endpoint", () => {
  it("accepts authenticated after-session requests", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/sessions/ses_123/after-session?messageId=msg_123",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(enqueueRunnerJob).toHaveBeenCalledWith({
      kind: "after_session",
      sessionId: "ses_123",
      messageId: "msg_123",
    });
  });

  it("rejects missing after-session message ids", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/sessions/ses_123/after-session",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "messageId is required." });
  });
});

describe("SSE formatting", () => {
  it("formats runtime events as unnamed SSE messages", () => {
    const event: PersistedRuntimeEvent = {
      id: 42,
      sessionId: "ses_123",
      messageId: "msg_123",
      type: "message.completed",
      payload: { messageId: "msg_123", content: "hello" },
      createdAt: new Date("2026-05-22T00:00:00.000Z"),
    };

    expect(formatSseEvent(event)).toBe(
      'id: 42\ndata: {"id":42,"type":"message.completed","payload":{"messageId":"msg_123","content":"hello"},"messageId":"msg_123","createdAt":"2026-05-22T00:00:00.000Z"}\n\n',
    );
  });

  it("includes createdAt as an ISO string in the SSE payload so web clients can compute thinking duration", () => {
    const createdAt = new Date("2026-05-28T12:00:01.500Z");
    const event: PersistedRuntimeEvent = {
      id: 7,
      sessionId: "ses_abc",
      messageId: "msg_abc",
      type: "tool.started",
      payload: { toolCallId: "call_1", name: "read_file", input: {} },
      createdAt,
    };

    const raw = formatSseEvent(event);
    const dataLine = raw.split("\ndata: ")[1];
    expect(dataLine).toBeDefined();
    const data = JSON.parse(dataLine!.trim());
    expect(data.createdAt).toBe(createdAt.toISOString());
  });

  it("formats events returned from raw SQL with string timestamps", () => {
    const event: PersistedRuntimeEvent = {
      id: 8,
      sessionId: "ses_abc",
      messageId: "msg_abc",
      type: "message.created",
      payload: { messageId: "msg_abc", role: "assistant", internal: false },
      createdAt: "2026-05-28T12:00:01.500Z",
    };

    const raw = formatSseEvent(event);
    const dataLine = raw.split("\ndata: ")[1];
    expect(dataLine).toBeDefined();
    const data = JSON.parse(dataLine!.trim());
    expect(data.createdAt).toBe("2026-05-28T12:00:01.500Z");
  });

  it("formats transient runtime events without advancing Last-Event-ID", () => {
    const event: RuntimeEventForStream = {
      id: null,
      sessionId: "ses_abc",
      messageId: "msg_abc",
      type: "message.delta",
      payload: { messageId: "msg_abc", delta: "hello" },
      createdAt: new Date("2026-05-28T12:00:01.500Z"),
      transient: true,
    };

    expect(formatSseEvent(event)).toBe(
      'data: {"id":null,"type":"message.delta","payload":{"messageId":"msg_abc","delta":"hello"},"messageId":"msg_abc","createdAt":"2026-05-28T12:00:01.500Z","transient":true}\n\n',
    );
  });

  it("formats stream errors as named SSE events", () => {
    expect(formatStreamError("Event stream failed.")).toBe(
      'event: session.error\ndata: {"message":"Event stream failed."}\n\n',
    );
  });

  it("includes CORS headers on hijacked SSE responses", () => {
    expect(createSseHeaders(env, "https://app.example.com")).toMatchObject({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Access-Control-Allow-Origin": "https://app.example.com",
      Vary: "Origin",
      "X-Accel-Buffering": "no",
    });
  });
});

describe("stream token redaction", () => {
  it("redacts EventSource query tokens from request log URLs", () => {
    expect(redactStreamToken("/sessions/ses_123/events?token=secret&after=4")).toBe(
      "/sessions/ses_123/events?token=%5Bredacted%5D&after=4",
    );
  });
});
