import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ACTION_EFFECTS_READ, type ResolvedActionCatalog } from "@opencompany/agent/actions/types";
import type { ActionGatewayServiceDependencies } from "@opencompany/agent/application/action-gateway";
import {
  createActionGateway,
  createActionHostGateway,
} from "@opencompany/agent/application/persisted-action-gateway";
import {
  ACTION_HOST_TOOL_CONTRACT_VERSION,
  ACTION_HOST_TOOL_CONTRACT_VERSION_V2,
  createExternalEngineGatewayTicket,
} from "@opencompany/agent-runtime";
import { CODEX_BRAIN_TOOL_CONTRACT_VERSION } from "@opencompany/brain";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeExternalActionWithApproval,
  registerAcpToolsMcpRoute,
  sanitizeApprovalToolInput,
} from "./acp-tools-mcp";
import type { RunnerEnv } from "./env";

const env = {
  internalToken: "runner-secret",
  apiOrigin: "https://api.example.com",
  apiInternalToken: "api-internal-secret",
  vercelAiGatewayApiKey: "gateway-key",
} as RunnerEnv;
const capability = {
  codexChatSessionId: "session_1",
  codexChatTurnId: "run_1",
  attemptId: "attempt_1",
  leaseId: "lease_1",
};
const apps: ReturnType<typeof Fastify>[] = [];
const authorized = {
  actorId: "user_1",
  workspaceId: "workspace_1",
  workspaceName: "Acme",
  workspaceSlug: "acme",
  legacyBrainEnabled: false,
  conversationId: "conversation_1",
  sandboxId: "sandbox_1",
  engine: "claude_code" as const,
  brainRef: null,
  userMessageId: "message_user_1",
  assistantMessageId: "message_assistant_1",
  hostToolContractVersion: ACTION_HOST_TOOL_CONTRACT_VERSION,
};

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

describe("runner ACP tools MCP", () => {
  it("rejects a missing sandbox capability", async () => {
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, {
      authorize: vi.fn(async () => authorized),
    });

    const missing = await app.inject({
      method: "POST",
      url: "/internal/goat/acp-tools",
    });
    expect(missing.statusCode).toBe(401);
  });

  it("rate-limits invalid capabilities before authorization", async () => {
    const app = Fastify();
    apps.push(app);
    const authorize = vi.fn(async () => authorized);
    registerAcpToolsMcpRoute(app, env, { authorize, rateLimitMax: 2 });

    const request = {
      method: "POST" as const,
      url: "/internal/goat/acp-tools",
      headers: { "x-opencompany-tool-ticket": "invalid" },
    };
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject(request)).statusCode).toBe(429);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects an oversized MCP body before tool dispatch", async () => {
    const app = Fastify();
    apps.push(app);
    const executeAction = vi.fn();
    registerAcpToolsMcpRoute(app, env, { executeAction });

    const response = await app.inject({
      method: "POST",
      url: "/internal/goat/acp-tools",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ value: "x".repeat(256 * 1024) }),
    });

    expect(response.statusCode).toBe(413);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("initializes and reauthorizes every MCP tool operation", async () => {
    const authorize = vi.fn(async () => authorized);
    const executeAction = vi.fn(async () => ({ ok: true as const, sources: [] }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize, executeAction });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "publish_artifact",
        "list_actions",
        "use_action",
        "wiki",
      ]);
      const result = await client.callTool({ name: "list_actions", arguments: {} });
      expect(result.isError).toBe(false);
      expect(executeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          request: { operation: "list", sessionId: "session_1", turnId: "run_1" },
        }),
      );
      expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      await client.close();
    }
  });

  it("dispatches execute operations through the persisted action gateway", async () => {
    const catalog: ResolvedActionCatalog = {
      providers: [{ id: "gmail", label: "Gmail", description: "Email" }],
      actions: [
        {
          id: "gmail.search",
          provider: "gmail",
          capability: "read",
          effects: ACTION_EFFECTS_READ,
          description: "Search Gmail.",
          params: { type: "object" },
          permissionMode: "on",
          execute: vi.fn(async () => ({ messages: [] })),
        },
      ],
    };
    const providerExecuteAction = vi.fn<ActionGatewayServiceDependencies["executeAction"]>(
      async ({ actionId }) => ({
        ok: true,
        action: actionId,
        result: { messages: [] },
      }),
    );
    const serviceDependencies = {
      loadContext: vi.fn(async () => ({
        actorId: authorized.actorId,
        workspaceId: authorized.workspaceId,
        conversationId: authorized.conversationId,
        userTimezone: "Europe/Berlin",
        policy: "foregroundInteractive" as const,
      })),
      resolveCatalog: vi.fn(async () => catalog),
      claimInvocation: vi.fn(async () => ({
        ok: true as const,
        callCount: 1,
        duplicate: false,
      })),
      recordSourceDiscovery: vi.fn(async () => undefined),
      executeAction: providerExecuteAction,
    } satisfies Partial<ActionGatewayServiceDependencies>;
    const executeAction = vi.fn(createActionGateway(serviceDependencies));
    const request = {
      operation: "execute" as const,
      sessionId: capability.codexChatSessionId,
      turnId: capability.codexChatTurnId,
      action: "gmail.search",
      params: { query: "from:ada" },
      invocationId: "invocation_1",
    };
    const signal = new AbortController().signal;

    const result = await executeExternalActionWithApproval({
      request,
      signal,
      capability: { ...capability, v: 2, expiresAt: Date.now() + 60_000 },
      authorizedContext: authorized,
      authorizeOperation: vi.fn(async () => authorized),
      dependencies: {
        executeAction,
        evaluateApproval: createActionHostGateway(serviceDependencies),
        requestApproval: vi.fn(),
        waitForApproval: vi.fn(),
        resolveApproval: vi.fn(),
      },
    });

    expect(result).toEqual({
      ok: true,
      action: "gmail.search",
      result: { messages: [] },
    });
    expect(executeAction).toHaveBeenCalledWith({ request, signal });
    expect(providerExecuteAction).toHaveBeenCalledOnce();
  });

  it("proxies the scoped wiki tool through the canonical API boundary", async () => {
    const authorize = vi.fn(async () => authorized);
    const executeWikiCommand = vi.fn(async () => ({
      ok: true as const,
      result: { action: "updated", path: "projects/launch" },
    }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize, executeWikiCommand });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      const wikiTool = (await client.listTools()).tools.find((tool) => tool.name === "wiki");
      expect(wikiTool?.inputSchema.properties).toMatchObject({
        depth: expect.any(Object),
        title: expect.any(Object),
      });
      const result = await client.callTool({
        name: "wiki",
        arguments: {
          command: "write",
          path: "projects/launch",
          body: "# Launch",
        },
      });
      expect(result.isError).toBe(false);
      expect(executeWikiCommand).toHaveBeenCalledWith({
        origin: env.apiOrigin,
        token: env.apiInternalToken,
        workspaceId: "workspace_1",
        actorId: "user_1",
        toolInput: {
          command: "write",
          path: "projects/launch",
          body: "# Launch",
        },
        idempotencyKey: expect.stringMatching(/^acp-wiki:run_1:[a-f0-9]{24}$/u),
        signal: expect.any(AbortSignal),
      });
      expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      await client.close();
    }
  });

  it("advertises wiki when legacy Brain is disabled", async () => {
    const authorize = vi.fn(async () => ({ ...authorized, legacyBrainEnabled: false }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "publish_artifact",
        "list_actions",
        "use_action",
        "wiki",
      ]);
    } finally {
      await client.close();
    }
  });

  it("fails a tool call if its lease becomes stale", async () => {
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(authorized)
      .mockResolvedValueOnce(authorized)
      .mockResolvedValueOnce(null);
    const executeAction = vi.fn(async () => ({ ok: true as const, sources: [] }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize, executeAction });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      await expect(client.callTool({ name: "list_actions", arguments: {} })).rejects.toThrow(
        "This engine turn is no longer active",
      );
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it.each([
    {
      engine: "codex" as const,
      decision: "approved" as const,
      executes: true,
      expectedError: false,
    },
    {
      engine: "codex" as const,
      decision: "denied" as const,
      executes: false,
      expectedError: true,
    },
    {
      engine: "claude_code" as const,
      decision: "approved" as const,
      executes: true,
      expectedError: false,
    },
    {
      engine: "claude_code" as const,
      decision: "denied" as const,
      executes: false,
      expectedError: true,
    },
  ])(
    "parks a $engine ask action until it is $decision",
    async ({ engine, decision, executes, expectedError }) => {
      const authorize = vi.fn(async () => ({ ...authorized, engine }));
      const executeAction = vi.fn(async () => ({
        ok: true as const,
        action: "gmail.send",
        result: { sent: true },
      }));
      const evaluateApproval = vi.fn(async () => ({
        ok: true as const,
        needsApproval: true,
      }));
      const requestApproval = vi.fn(async () => "approval_1");
      const waitForApproval = vi.fn(
        async (input: {
          reportProgress?: (progress: { progress: number; message: string }) => Promise<void>;
        }) => {
          await input.reportProgress?.({
            progress: 1,
            message: "Waiting for user approval.",
          });
          return decision;
        },
      );
      const resolveApproval = vi.fn(async () => ({
        ok: true as const,
        duplicate: false,
        record: {
          actionId: "gmail.send",
          sourceId: "gmail",
          capabilityId: "write",
          inputHash: "a".repeat(64),
          status: decision,
          requestedAt: "2026-08-26T00:00:00.000Z",
          resolvedAt: "2026-08-26T00:01:00.000Z",
        },
      }));
      const app = Fastify();
      apps.push(app);
      registerAcpToolsMcpRoute(app, env, {
        authorize,
        executeAction,
        evaluateApproval,
        requestApproval,
        waitForApproval,
        resolveApproval,
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
      const ticket = createExternalEngineGatewayTicket({
        ...capability,
        secret: env.internalToken,
      }).ticket;
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
        { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
      );
      const client = new Client({ name: "runner-test", version: "0.1.0" });
      const onprogress = vi.fn();

      try {
        await client.connect(transport as Parameters<typeof client.connect>[0]);
        const result = await client.callTool(
          {
            name: "use_action",
            arguments: {
              action: "gmail.send",
              params: { to: "customer@example.com" },
            },
          },
          undefined,
          { onprogress, resetTimeoutOnProgress: true },
        );

        expect(result.isError).toBe(expectedError);
        expect(evaluateApproval).toHaveBeenCalledOnce();
        expect(requestApproval).toHaveBeenCalledOnce();
        expect(requestApproval).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "gmail.send",
            params: { to: "customer@example.com" },
          }),
        );
        expect(waitForApproval).toHaveBeenCalledWith(
          expect.objectContaining({ approvalId: "approval_1", runId: "run_1" }),
        );
        expect(resolveApproval).toHaveBeenCalledWith(
          expect.objectContaining({ decision, invocationId: expect.stringContaining("mcp:run_1") }),
        );
        expect(executeAction).toHaveBeenCalledTimes(executes ? 1 : 0);
        expect(onprogress).toHaveBeenCalledWith({
          progress: 1,
          message: "Waiting for user approval.",
        });
        if (!executes) {
          expect(result.structuredContent).toMatchObject({
            ok: false,
            error: { code: "not_permitted" },
          });
        }
      } finally {
        await client.close();
      }
    },
  );

  it("does not execute when an approval waiter outlives its MCP call", async () => {
    const controller = new AbortController();
    const executeAction = vi.fn(async () => ({
      ok: true as const,
      action: "gmail.send",
      result: { sent: true },
    }));
    const resolveApproval = vi.fn();

    const result = await executeExternalActionWithApproval({
      request: {
        operation: "execute",
        sessionId: "session_1",
        turnId: "run_1",
        action: "gmail.send",
        params: { to: "customer@example.com" },
        invocationId: "invocation_1",
      },
      signal: controller.signal,
      capability: { ...capability, v: 2, expiresAt: Date.now() + 60_000 },
      authorizedContext: authorized,
      authorizeOperation: vi.fn(async () => authorized),
      dependencies: {
        executeAction,
        evaluateApproval: vi.fn(async () => ({
          ok: true as const,
          needsApproval: true,
        })),
        requestApproval: vi.fn(async () => "approval_1"),
        waitForApproval: vi.fn(async () => {
          controller.abort();
          return "approved" as const;
        }),
        resolveApproval,
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "canceled" } });
    expect(executeAction).not.toHaveBeenCalled();
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("does not attribute a missing approval record to the user", async () => {
    const executeAction = vi.fn();
    const resolveApproval = vi.fn();
    const result = await executeExternalActionWithApproval({
      request: {
        operation: "execute",
        sessionId: "session_1",
        turnId: "run_1",
        action: "gmail.send",
        params: {},
        invocationId: "invocation_1",
      },
      signal: new AbortController().signal,
      capability: { ...capability, v: 2, expiresAt: Date.now() + 60_000 },
      authorizedContext: authorized,
      authorizeOperation: vi.fn(async () => authorized),
      dependencies: {
        executeAction,
        evaluateApproval: vi.fn(async () => ({
          ok: true as const,
          needsApproval: true,
        })),
        requestApproval: vi.fn(async () => "approval_1"),
        waitForApproval: vi.fn(async () => "approval_missing" as const),
        resolveApproval,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "internal",
        message: "The action approval record is unavailable.",
      },
    });
    expect(executeAction).not.toHaveBeenCalled();
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("sanitizes sensitive and oversized parameters before approval projection", () => {
    const input = sanitizeApprovalToolInput("gmail.send", {
      to: "customer@example.com",
      body: "x".repeat(4_001),
      accessToken: "do-not-project",
      nested: { password: "do-not-project", visible: "yes" },
    });

    expect(input).toMatchObject({
      action: "gmail.send",
      params: {
        to: "customer@example.com",
        accessToken: "[REDACTED]",
        nested: { password: "[REDACTED]", visible: "yes" },
      },
    });
    expect((input.params.body as string).endsWith("…")).toBe(true);
    expect(JSON.stringify(input)).not.toContain("do-not-project");
  });

  it("exposes actions, artifacts, Brain reads, and Brain capture to Codex", async () => {
    const authorize = vi.fn(async () => ({
      ...authorized,
      engine: "codex" as const,
      brainRef: "brain_1",
      legacyBrainEnabled: true,
    }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "publish_artifact",
        "list_actions",
        "use_action",
        "wiki",
        "goat_brain",
        "save_to_brain",
      ]);
    } finally {
      await client.close();
    }
  });

  it("preserves read-only Brain access for legacy pinned sessions", async () => {
    const authorize = vi.fn(async () => ({
      ...authorized,
      engine: "codex" as const,
      brainRef: "brain_1",
      legacyBrainEnabled: true,
      hostToolContractVersion: CODEX_BRAIN_TOOL_CONTRACT_VERSION,
    }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "wiki",
        "goat_brain",
      ]);
    } finally {
      await client.close();
    }
  });

  it("registers the Wiki tool for retained v2 host-tool sessions", async () => {
    const authorize = vi.fn(async () => ({
      ...authorized,
      hostToolContractVersion: ACTION_HOST_TOOL_CONTRACT_VERSION_V2,
    }));
    const app = Fastify();
    apps.push(app);
    registerAcpToolsMcpRoute(app, env, { authorize });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const ticket = createExternalEngineGatewayTicket({
      ...capability,
      secret: env.internalToken,
    }).ticket;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
      { requestInit: { headers: { "x-opencompany-tool-ticket": ticket } } },
    );
    const client = new Client({ name: "runner-test", version: "0.1.0" });

    try {
      await client.connect(transport as Parameters<typeof client.connect>[0]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("wiki");
    } finally {
      await client.close();
    }
  });
});
