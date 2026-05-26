import { createSessionStreamToken } from "@opencompany/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAfterSession } from "./agent-loop";
import type { PersistedRuntimeEvent } from "./events";
import {
  createServer,
  createSseHeaders,
  formatSseEvent,
  formatStreamError,
  redactStreamToken,
} from "./server";
import { generateSessionTitleForMessage } from "./session-title";

vi.mock("./agent-loop", () => ({
  abortSession: vi.fn(async () => undefined),
  archiveSession: vi.fn(async () => undefined),
  runAfterSession: vi.fn(async () => undefined),
  runMessage: vi.fn(async () => undefined),
  startSession: vi.fn(async () => undefined),
}));

vi.mock("./session-title", () => ({
  generateSessionTitleForMessage: vi.fn(async () => ({ ok: true, title: "Generated title" })),
}));

const env = {
  databaseUrl: "postgres://example",
  internalToken: "internal-secret",
  streamTokenSecret: "stream-secret",
  e2bApiKey: "e2b",
  vercelAiGatewayApiKey: "gateway",
  exaApiKey: undefined,
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
    expect(generateSessionTitleForMessage).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_123",
      env,
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
    expect(runAfterSession).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_123",
      env,
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
      'id: 42\ndata: {"id":42,"type":"message.completed","payload":{"messageId":"msg_123","content":"hello"},"messageId":"msg_123"}\n\n',
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
