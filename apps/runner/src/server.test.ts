import { afterEach, describe, expect, it, vi } from "vitest";
import { mintCodingWorkspaceAccess } from "./coding-workspace-runtime";
import { verifyDictationTicket } from "./dictation-auth";
import { startInfisicalAuthFlow } from "./infisical-auth";
import { getSandboxLifecycleStatus, killSandbox } from "./sandbox";
import { createServer } from "./server";
import { wakeWikiIngestWorker } from "./wiki-ingest-worker";

vi.mock("./coding-workspace-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("./coding-workspace-runtime")>();
  return {
    ...original,
    mintCodingWorkspaceAccess: vi.fn(async () => ({
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
  completeInfisicalAuthFlow: vi.fn(async () => null),
  startInfisicalAuthFlow: vi.fn(async () => ({
    id: "ginff_eu",
    status: "link_ready",
    loginUrl: "https://eu.infisical.com/login?callback_port=23456",
    statusReason: null,
    expiresAt: "2026-08-07T09:00:00.000Z",
  })),
}));

vi.mock("./wiki-ingest-worker", () => ({
  wakeWikiIngestWorker: vi.fn(),
}));

const env = {
  internalToken: "internal-secret",
  streamTokenSecret: "stream-secret",
  apiOrigin: "http://localhost:3001",
  apiInternalToken: "api-internal-secret",
  vercelAiGatewayApiKey: "gateway",
  openaiCodexApiKey: undefined,
  openaiApiKey: "openai",
  dictationRealtimeModel: undefined,
  dictationFinalModel: undefined,
  exaApiKey: undefined,
  browserEnabled: false,
  codexE2bTemplate: undefined,
  sandboxNamespace: "test",
  codexTimeoutMs: 1_200_000,
  codexModel: "gpt-5.5",
  codexChatIdleTimeoutMs: 1_800_000,
  jobLeaseTtlMs: 300_000,
  taskWorkerEnabled: false,
  codexChatSelfHealEnabled: true,
  workerConcurrency: 2,
  port: 3040,
  allowedOrigins: ["https://app.example.com"],
  instanceId: "runner-test",
};
const workerEnv = {
  ...env,
  taskWorkerEnabled: true,
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
      capabilities: { acpToolsMcp: "v3", brainWorkerAdmission: "postgres-v1" },
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

describe("internal wiki ingest wake endpoint", () => {
  it("wakes the wiki worker when task workers are enabled", async () => {
    const server = createServer(workerEnv);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/wiki-ingest/wake",
      headers: { authorization: `Bearer ${workerEnv.internalToken}` },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(wakeWikiIngestWorker).toHaveBeenCalledOnce();
  });

  it("does not wake the wiki worker when task workers are disabled", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/wiki-ingest/wake",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(503);
    expect(wakeWikiIngestWorker).not.toHaveBeenCalled();
  });
});

describe("Slack answer-bot event dispatch", () => {
  it("requires internal auth and enqueues a versioned event command", async () => {
    const enqueue = vi.fn();
    const server = createServer(workerEnv, { slackBotEvents: { enqueue } });
    servers.push(server);
    const payload = {
      schemaVersion: 1,
      eventId: "Ev123",
      claimId: "gsbec_claim",
      kind: "mention",
      input: {
        teamId: "T123",
        channelId: "C123",
        messageTs: "1784196000.000100",
        threadTs: null,
        text: "<@B123> what changed?",
        slackUserId: "U123",
      },
    };

    const unauthorized = await server.inject({
      method: "POST",
      url: "/internal/goat/slack-bot/events",
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/slack-bot/events",
      headers: { authorization: `Bearer ${workerEnv.internalToken}` },
      payload,
    });
    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(payload);
  });

  it("rejects malformed commands and disabled workers", async () => {
    const enqueue = vi.fn();
    const disabled = createServer(env, { slackBotEvents: { enqueue } });
    servers.push(disabled);
    const disabledResponse = await disabled.inject({
      method: "POST",
      url: "/internal/goat/slack-bot/events",
      headers: { authorization: `Bearer ${env.internalToken}` },
      payload: { schemaVersion: 1 },
    });
    expect(disabledResponse.statusCode).toBe(503);

    const enabled = createServer(workerEnv, { slackBotEvents: { enqueue } });
    servers.push(enabled);
    const invalid = await enabled.inject({
      method: "POST",
      url: "/internal/goat/slack-bot/events",
      headers: { authorization: `Bearer ${workerEnv.internalToken}` },
      payload: { schemaVersion: 1 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("opencompany action standing permissions", () => {
  it("requires internal auth and forwards an actor-scoped command", async () => {
    const alwaysAllow = vi.fn(async () => ({ changed: true }));
    const server = createServer(workerEnv, { actionPermissions: { alwaysAllow } });
    servers.push(server);
    const payload = {
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      actionId: "gmail.send_email",
    };

    const unauthorized = await server.inject({
      method: "POST",
      url: "/internal/goat/actions/always-allow",
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/actions/always-allow",
      headers: { authorization: `Bearer ${workerEnv.internalToken}` },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, changed: true });
    expect(alwaysAllow).toHaveBeenCalledWith(payload);
  });
});

describe("opencompany Infisical authentication", () => {
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
    expect(startInfisicalAuthFlow).toHaveBeenCalledWith({
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
    expect(startInfisicalAuthFlow).not.toHaveBeenCalled();
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
    expect(startInfisicalAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ host: "https://app.infisical.com" }),
    );
  });
});

describe("opencompany coding workspace access", () => {
  it("rejects missing owner claims", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/coding-workspaces/sessions/runtime_1/runtime-access",
      headers: { authorization: `Bearer ${env.internalToken}` },
    });

    expect(response.statusCode).toBe(400);
    expect(mintCodingWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("requires internal auth and passes the claimed owner to ticket minting", async () => {
    const server = createServer(env);
    servers.push(server);

    const unauthorized = await server.inject({
      method: "POST",
      url: "/internal/goat/coding-workspaces/sessions/runtime_1/runtime-access",
      payload: { userWorkosId: "user_1" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/coding-workspaces/sessions/runtime_1/runtime-access",
      headers: { authorization: `Bearer ${env.internalToken}` },
      payload: { userWorkosId: "user_1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ticket: "ticket_1",
      sandboxStatus: "sleeping",
    });
    expect(mintCodingWorkspaceAccess).toHaveBeenCalledWith({
      codingSessionId: "runtime_1",
      userWorkosId: "user_1",
      env,
    });
  });

  it("keeps forwarding legacy session ids during rolling deployments", async () => {
    const server = createServer(env);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/internal/goat/coding-workspaces/sessions/goat_codex_chat_1/runtime-access",
      headers: { authorization: `Bearer ${env.internalToken}` },
      payload: { userWorkosId: "user_1" },
    });

    expect(response.statusCode).toBe(200);
    expect(mintCodingWorkspaceAccess).toHaveBeenCalledWith({
      codingSessionId: "goat_codex_chat_1",
      userWorkosId: "user_1",
      env,
    });
  });
});

describe("opencompany dictation access", () => {
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
      verifyDictationTicket({
        ticket: body.ticket,
        secret: env.streamTokenSecret,
      }),
    ).toMatchObject({ userWorkosId: "user_1" });
  });
});

describe("internal opencompany Codex sandbox status endpoint", () => {
  it("returns the E2B sandbox lifecycle status", async () => {
    vi.mocked(getSandboxLifecycleStatus).mockResolvedValue("sleeping");
    const server = createServer(workerEnv);
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/internal/goat/codex-chat/sandboxes/sbx_123/status",
      headers: { authorization: `Bearer ${workerEnv.internalToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: "sleeping" });
    expect(getSandboxLifecycleStatus).toHaveBeenCalledWith("sbx_123");
  });
});

describe("internal opencompany Codex sandbox kill endpoint", () => {
  it("kills the E2B sandbox", async () => {
    const server = createServer(workerEnv);
    servers.push(server);

    const response = await server.inject({
      method: "DELETE",
      url: "/internal/goat/codex-chat/sandboxes/sbx_123",
      headers: { authorization: `Bearer ${workerEnv.internalToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, killed: true });
    expect(killSandbox).toHaveBeenCalledWith("sbx_123");
  });

  it("rejects unauthenticated kills", async () => {
    const server = createServer(workerEnv);
    servers.push(server);

    const response = await server.inject({
      method: "DELETE",
      url: "/internal/goat/codex-chat/sandboxes/sbx_123",
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(killSandbox).not.toHaveBeenCalled();
  });
});
