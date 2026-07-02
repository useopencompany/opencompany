import { afterEach, describe, expect, it, vi } from "vitest";
import { executeGoatGoogleTool } from "./goat-google-tools";
import { createGoatToolToken } from "./goat-tool-auth";
import { wakeGoatTaskWorker } from "./goat-worker";
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

vi.mock("./goat-worker", () => ({
  wakeGoatTaskWorker: vi.fn(),
}));

vi.mock("./goat-google-tools", () => ({
  executeGoatGoogleTool: vi.fn(async () => ({ messages: [] })),
  isGoatGoogleToolName: (name: string) => name === "gmail_search",
}));

const env = {
  databaseUrl: "postgres://example",
  internalToken: "internal-secret",
  streamTokenSecret: "stream-secret",
  e2bApiKey: "e2b",
  vercelAiGatewayApiKey: "gateway",
  openaiCodexApiKey: undefined,
  publicUrl: undefined,
  llmBrokerEnabled: true,
  integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
  exaApiKey: undefined,
  xApiBearerToken: undefined,
  supadataApiKey: undefined,
  ampApiKey: undefined,
  e2bTemplate: undefined,
  ampE2bTemplate: undefined,
  codexE2bTemplate: undefined,
  e2bSandboxIdleTimeoutMs: 30_000,
  opencodeTimeoutMs: 1_200_000,
  codexTimeoutMs: 1_200_000,
  codexModel: "gpt-5.5",
  toolArgRepairEnabled: false,
  jobLeaseTtlMs: 300_000,
  jobMaxLeaseBusyAttempts: 10,
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

describe("internal Goat task run endpoint", () => {
  it("wakes the Goat worker for authenticated task requests", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/tasks/goat_task_123/run",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(wakeGoatTaskWorker).toHaveBeenCalledTimes(1);
  });
});

describe("Goat tool endpoint", () => {
  it("executes authenticated task-scoped tool requests", async () => {
    const server = createServer(env);
    servers.push(server);
    const token = createGoatToolToken({
      taskId: "goat_task_123",
      userWorkosId: "user_123",
      secret: env.internalToken,
      expiresInMs: 60_000,
    });

    const response = await server.inject({
      method: "POST",
      url: "/goat/tools/goat_task_123",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "gmail_search",
        args: { query: "is:unread" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, output: { messages: [] } });
    expect(executeGoatGoogleTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "gmail_search",
        args: { query: "is:unread" },
        userWorkosId: "user_123",
      }),
    );
  });

  it("rejects Goat tool requests without a valid task token", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/goat/tools/goat_task_123",
      headers: { authorization: "Bearer invalid" },
      payload: { name: "gmail_search", args: {} },
    });

    expect(response.statusCode).toBe(401);
    expect(executeGoatGoogleTool).not.toHaveBeenCalled();
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

  it("persists a Codex turn job before accepting authenticated Codex message requests", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/sessions/ses_123/messages/msg_123/codex-turn",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(enqueueRunnerJob).toHaveBeenCalledWith({
      kind: "codex_turn",
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
