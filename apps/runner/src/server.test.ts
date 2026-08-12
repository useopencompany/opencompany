import { afterEach, describe, expect, it, vi } from "vitest";
import { mintGoatCodingWorkspaceAccess } from "./goat-coding-workspace-runtime";
import { verifyGoatDictationTicket } from "./goat-dictation-auth";
import { startGoatInfisicalAuthFlow } from "./infisical-auth";
import { getSandboxLifecycleStatus, killSandbox } from "./sandbox";
import { createServer } from "./server";

vi.mock("./goat-coding-workspace-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("./goat-coding-workspace-runtime")>();
  return {
    ...original,
    mintGoatCodingWorkspaceAccess: vi.fn(async () => ({
      ticket: "ticket_1",
      expiresAt: 60_000,
      sandboxStatus: "sleeping",
    })),
  };
});

vi.mock("./sandbox", () => ({
  getSandboxLifecycleStatus: vi.fn(async () => "running"),
  killSandbox: vi.fn(async () => true),
}));

vi.mock("./infisical-auth", () => ({
  completeGoatInfisicalAuthFlow: vi.fn(async () => null),
  startGoatInfisicalAuthFlow: vi.fn(async () => ({
    id: "ginff_eu",
    status: "link_ready",
    loginUrl: "https://eu.infisical.com/login?callback_port=23456",
    statusReason: null,
    expiresAt: "2026-08-07T09:00:00.000Z",
  })),
}));

const env = {
  internalToken: "internal-secret",
  streamTokenSecret: "stream-secret",
  vercelAiGatewayApiKey: "gateway",
  openaiCodexApiKey: undefined,
  openaiApiKey: "openai",
  goatDictationRealtimeModel: undefined,
  goatDictationFinalModel: undefined,
  exaApiKey: undefined,
  goatBrowserEnabled: false,
  codexE2bTemplate: undefined,
  codexTimeoutMs: 1_200_000,
  codexModel: "gpt-5.5",
  goatCodexChatIdleTimeoutMs: 1_800_000,
  jobLeaseTtlMs: 300_000,
  goatTaskWorkerEnabled: false,
  workerConcurrency: 2,
  port: 3040,
  allowedOrigins: ["https://app.example.com"],
  instanceId: "runner-test",
};
const goatEnv = {
  ...env,
  goatTaskWorkerEnabled: true,
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
    expect(response.json()).toMatchObject({
      capabilities: { claudeActionsMcp: "v2", brainWorkerAdmission: "postgres-v1" },
    });
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

describe("runner execution transport surface", () => {
  it("does not expose the retired web-MCP artifact publication adapter", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/chat-artifacts/publish",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("Goat Infisical authentication", () => {
  it("passes an allowlisted EU host to the auth flow", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/infisical-auth/start",
      headers: { authorization: `Bearer ${env.internalToken}` },
      payload: {
        workspaceId: "workspace_1",
        requestedByWorkosId: "user_1",
        host: "https://eu.infisical.com",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(startGoatInfisicalAuthFlow).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      requestedByWorkosId: "user_1",
      host: "https://eu.infisical.com",
      env,
    });
  });

  it("rejects an untrusted Infisical host before starting a sandbox", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/infisical-auth/start",
      headers: { authorization: `Bearer ${env.internalToken}` },
      payload: {
        workspaceId: "workspace_1",
        requestedByWorkosId: "user_1",
        host: "https://evil.example",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(startGoatInfisicalAuthFlow).not.toHaveBeenCalled();
  });

  it("keeps omitted hosts on US during a rolling deployment", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/infisical-auth/start",
      headers: { authorization: `Bearer ${env.internalToken}` },
      payload: {
        workspaceId: "workspace_1",
        requestedByWorkosId: "user_1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(startGoatInfisicalAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ host: "https://app.infisical.com" }),
    );
  });
});

describe("Goat coding workspace access", () => {
  it("rejects missing owner claims", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/coding-workspaces/sessions/goat_codex_chat_1/runtime-access",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(mintGoatCodingWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("requires internal auth and passes the claimed owner to ticket minting", async () => {
    const server = createServer(env);
    servers.push(server);

    const unauthorized = await server.inject({
      method: "POST",
      url: "/internal/goat/coding-workspaces/sessions/goat_codex_chat_1/runtime-access",
      payload: { userWorkosId: "user_1" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/coding-workspaces/sessions/goat_codex_chat_1/runtime-access",
      headers: { authorization: `Bearer ${env.internalToken}` },
      payload: { userWorkosId: "user_1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ticket: "ticket_1",
      sandboxStatus: "sleeping",
    });
    expect(mintGoatCodingWorkspaceAccess).toHaveBeenCalledWith({
      codingSessionId: "goat_codex_chat_1",
      userWorkosId: "user_1",
      env,
    });
  });
});

describe("Goat dictation access", () => {
  it("requires internal auth and returns an owner-bound ticket", async () => {
    const server = createServer(env);
    servers.push(server);

    const unauthorized = await server.inject({
      method: "POST",
      url: "/internal/goat/dictation/access",
      payload: { userWorkosId: "user_1" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const missingOwner = await server.inject({
      method: "POST",
      url: "/internal/goat/dictation/access",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });
    expect(missingOwner.statusCode).toBe(400);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/dictation/access",
      headers: { authorization: `Bearer ${env.internalToken}` },
      payload: { userWorkosId: "user_1" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { ticket: string; expiresAt: number };
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(
      verifyGoatDictationTicket({
        ticket: body.ticket,
        secret: env.streamTokenSecret,
      }),
    ).toMatchObject({ userWorkosId: "user_1" });
  });
});

describe("internal Goat Codex sandbox status endpoint", () => {
  it("returns the E2B sandbox lifecycle status", async () => {
    vi.mocked(getSandboxLifecycleStatus).mockResolvedValue("sleeping");
    const server = createServer(goatEnv);
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/internal/goat/codex-chat/sandboxes/sbx_123/status",
      headers: { authorization: `Bearer ${goatEnv.internalToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: "sleeping" });
    expect(getSandboxLifecycleStatus).toHaveBeenCalledWith("sbx_123");
  });
});

describe("internal Goat Codex sandbox kill endpoint", () => {
  it("kills the E2B sandbox", async () => {
    const server = createServer(goatEnv);
    servers.push(server);

    const response = await server.inject({
      method: "DELETE",
      url: "/internal/goat/codex-chat/sandboxes/sbx_123",
      headers: { authorization: `Bearer ${goatEnv.internalToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, killed: true });
    expect(killSandbox).toHaveBeenCalledWith("sbx_123");
  });

  it("rejects unauthenticated kills", async () => {
    const server = createServer(goatEnv);
    servers.push(server);

    const response = await server.inject({
      method: "DELETE",
      url: "/internal/goat/codex-chat/sandboxes/sbx_123",
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(killSandbox).not.toHaveBeenCalled();
  });
});
