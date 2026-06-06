import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueRunnerJob } from "./jobs";
import { createServer } from "./server";

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
  integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
  exaApiKey: undefined,
  xApiBearerToken: undefined,
  supadataApiKey: undefined,
  ampApiKey: undefined,
  e2bTemplate: undefined,
  ampE2bTemplate: undefined,
  e2bSandboxIdleTimeoutMs: 30_000,
  opencodeTimeoutMs: 1_200_000,
  toolArgRepairEnabled: false,
  workerConcurrency: 2,
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
