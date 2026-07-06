import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { registerLlmBrokerRoutes } from "./llm-broker";
import {
  type BrokerSpendInput,
  type BrokerTokenStore,
  hashBrokerToken,
  type ValidatedBrokerToken,
} from "./llm-broker-tokens";

vi.mock("./agent-loop", () => ({
  abortSession: vi.fn(async () => undefined),
  archiveSession: vi.fn(async () => undefined),
}));

vi.mock("./jobs", () => ({
  enqueueRunnerJob: vi.fn(async () => ({ id: 1, status: "pending" })),
}));

const env = {
  databaseUrl: "postgres://example",
  internalToken: "internal-secret",
  streamTokenSecret: "stream-secret",
  e2bApiKey: "e2b",
  vercelAiGatewayApiKey: "gateway-upstream-key",
  openaiCodexApiKey: "openai-upstream-key",
  publicUrl: "https://runner.example.com",
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
  toolArgRepairEnabled: false,
  jobLeaseTtlMs: 300_000,
  jobMaxLeaseBusyAttempts: 10,
  goatTaskWorkerEnabled: false,
  workerConcurrency: 2,
  port: 3040,
  allowedOrigins: ["https://app.example.com"],
  instanceId: "runner-test",
} as RunnerEnv;

type FakeToken = ValidatedBrokerToken & { tokenHash: string };

function createFakeStore(
  tokens: FakeToken[],
  options: { onRecordSpend?: (input: BrokerSpendInput) => Promise<void> | void } = {},
) {
  const spends: BrokerSpendInput[] = [];
  const store: BrokerTokenStore = {
    async insertToken() {},
    async findActiveByHash(tokenHash) {
      const token = tokens.find((candidate) => candidate.tokenHash === tokenHash);
      if (!token) return null;
      const { tokenHash: _hash, ...validated } = token;
      return validated;
    },
    async recordSpend(input) {
      spends.push(input);
      await options.onRecordSpend?.(input);
    },
    async revokeToken() {},
    async revokeTokensForSession() {
      return [];
    },
    async claimSettlement() {
      return null;
    },
    async releaseSettlementClaim() {},
    async findSettleableTokenIds() {
      return [];
    },
    async insertSettledToolUsage() {
      return { id: 1 };
    },
    async linkSettledToolUsage() {},
  };
  return { store, spends };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

async function waitForSpend(spends: BrokerSpendInput[], expectedLength = 1): Promise<void> {
  await waitUntil(() => spends.length === expectedLength);
  expect(spends).toHaveLength(expectedLength);
}

const GATEWAY_TOKEN = "ocbt_gateway_token";
const OPENAI_TOKEN = "ocbt_openai_token";

function defaultTokens(): FakeToken[] {
  return [
    {
      id: "token-gateway",
      tokenHash: hashBrokerToken(GATEWAY_TOKEN),
      sessionId: "session-1",
      workspaceId: "workspace-1",
      toolName: "opencode_coder",
      provider: "gateway",
      budgetUsdMicros: null,
      spentUsdMicros: 0,
    },
    {
      id: "token-openai",
      tokenHash: hashBrokerToken(OPENAI_TOKEN),
      sessionId: "session-1",
      workspaceId: "workspace-1",
      toolName: "codex_coder",
      provider: "openai",
      budgetUsdMicros: null,
      spentUsdMicros: 0,
    },
  ];
}

const apps: Array<ReturnType<typeof Fastify>> = [];

function createBrokerApp(options: {
  tokens?: FakeToken[];
  fetchImpl?: typeof fetch;
  env?: RunnerEnv;
  onRecordSpend?: (input: BrokerSpendInput) => Promise<void> | void;
}) {
  const { store, spends } = createFakeStore(
    options.tokens ?? defaultTokens(),
    options.onRecordSpend ? { onRecordSpend: options.onRecordSpend } : {},
  );
  const app = Fastify({ logger: false });
  app.register(async (instance) => {
    registerLlmBrokerRoutes(instance, {
      env: options.env ?? env,
      store,
      fetchImpl: options.fetchImpl ?? (vi.fn() as unknown as typeof fetch),
    });
  });
  apps.push(app);
  return { app, spends };
}

function jsonUpstream(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
  vi.clearAllMocks();
});

describe("LLM broker auth", () => {
  it("rejects requests without a token", async () => {
    const { app } = createBrokerApp({});
    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      payload: { model: "anthropic/claude-sonnet-4.6" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("missing_token");
  });

  it("rejects unknown tokens", async () => {
    const { app } = createBrokerApp({});
    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      headers: { authorization: "Bearer ocbt_unknown" },
      payload: { model: "anthropic/claude-sonnet-4.6" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("invalid_token");
  });

  it("rejects a token used against the wrong provider", async () => {
    const { app } = createBrokerApp({});
    const response = await app.inject({
      method: "POST",
      url: "/broker/openai/v1/responses",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "gpt-5.2-codex" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("provider_mismatch");
  });

  it("rejects a token used against the wrong endpoint for its tool", async () => {
    const { app } = createBrokerApp({});
    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/embeddings",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "openai/text-embedding-3-small", input: "hello" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("endpoint_not_allowed");
  });

  it("allows memory tokens to call embeddings without opening that endpoint to coding tools", async () => {
    const tokens = defaultTokens();
    tokens[0] = { ...tokens[0]!, toolName: "memory" };
    const fetchImpl = jsonUpstream({
      data: [{ embedding: [0.1] }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const { app } = createBrokerApp({ tokens, fetchImpl });

    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/embeddings",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "openai/text-embedding-3-small", input: "hello" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects an exhausted budget with 402", async () => {
    const tokens = defaultTokens();
    const gatewayToken = tokens[0];
    if (!gatewayToken) throw new Error("missing fixture");
    gatewayToken.budgetUsdMicros = 1_000;
    gatewayToken.spentUsdMicros = 1_000;
    const { app } = createBrokerApp({ tokens });
    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "anthropic/claude-sonnet-4.6" },
    });
    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe("budget_exhausted");
  });

  it("404s unknown providers and non-allowlisted paths", async () => {
    const { app } = createBrokerApp({});
    const unknownProvider = await app.inject({
      method: "POST",
      url: "/broker/anthropic/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: {},
    });
    expect(unknownProvider.statusCode).toBe(404);

    const unknownPath = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/files",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: {},
    });
    expect(unknownPath.statusCode).toBe(404);
  });

  it("503s when the upstream credential is not configured", async () => {
    const { app } = createBrokerApp({
      env: { ...env, openaiCodexApiKey: undefined } as RunnerEnv,
    });
    const response = await app.inject({
      method: "POST",
      url: "/broker/openai/v1/responses",
      headers: { authorization: `Bearer ${OPENAI_TOKEN}` },
      payload: { model: "gpt-5.2-codex" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("upstream_not_configured");
  });

  it("400s non-JSON bodies", async () => {
    const { app } = createBrokerApp({});
    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, "content-type": "text/plain" },
      payload: "not json",
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("LLM broker proxying", () => {
  it("forwards non-streaming responses verbatim, injects the upstream key, and meters spend", async () => {
    const upstreamBody = {
      id: "chatcmpl-1",
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    };
    const fetchImpl = jsonUpstream(upstreamBody);
    const { app, spends } = createBrokerApp({ fetchImpl });

    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "anthropic/claude-sonnet-4.6", messages: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(upstreamBody);

    const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gateway-upstream-key");

    await waitForSpend(spends);
    expect(spends[0]).toMatchObject({
      tokenId: "token-gateway",
      sessionId: "session-1",
      endpoint: "chat.completions",
      model: "anthropic/claude-sonnet-4.6",
      streamed: false,
      upstreamStatus: 200,
      inputTokens: 100,
      outputTokens: 10,
      usageParsed: true,
    });
    expect(spends[0]?.costUsdMicros).toBeGreaterThan(0);
  });

  it("fails a buffered response when the spend write cannot be persisted", async () => {
    const fetchImpl = jsonUpstream({
      id: "chatcmpl-1",
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });
    const { app } = createBrokerApp({
      fetchImpl,
      onRecordSpend: async () => {
        throw new Error("database unavailable");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "anthropic/claude-sonnet-4.6", messages: [] },
    });

    expect(response.statusCode).toBe(500);
  });

  it("pins the openai upstream for responses-API calls", async () => {
    const fetchImpl = jsonUpstream({ usage: { input_tokens: 5, output_tokens: 2 } });
    const { app } = createBrokerApp({ fetchImpl });

    const response = await app.inject({
      method: "POST",
      url: "/broker/openai/v1/responses",
      headers: { authorization: `Bearer ${OPENAI_TOKEN}` },
      payload: { model: "gpt-5.2-codex", input: "hello" },
    });
    expect(response.statusCode).toBe(200);

    const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer openai-upstream-key",
    );
  });

  it("injects stream_options.include_usage into streamed chat completions", async () => {
    const fetchImpl = jsonUpstream({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const { app } = createBrokerApp({ fetchImpl });

    await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "anthropic/claude-sonnet-4.6", stream: true },
    });

    const fetchMock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("passes SSE streams through byte-identical and meters the final usage chunk", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hel"}}],"usage":null}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}],"usage":null}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"cost":0.25}}\n\n',
      "data: [DONE]\n\n",
    ];
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;
    const { app, spends } = createBrokerApp({ fetchImpl });

    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "anthropic/claude-sonnet-4.6", stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(chunks.join(""));

    await waitForSpend(spends);
    expect(spends[0]).toMatchObject({
      streamed: true,
      inputTokens: 7,
      outputTokens: 2,
      usageParsed: true,
      // Gateway-reported $0.25 wins over catalog pricing.
      costUsdMicros: 250_000,
    });
  });

  it("keeps a streamed response open until the spend write completes", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"ok"}}],"usage":null}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    let releaseSpendWrite: () => void = () => {};
    let spendWriteStarted = false;
    const spendWriteGate = new Promise<void>((resolve) => {
      releaseSpendWrite = resolve;
    });
    const { app, spends } = createBrokerApp({
      fetchImpl,
      onRecordSpend: async () => {
        spendWriteStarted = true;
        await spendWriteGate;
      },
    });

    let responseSettled = false;
    const responsePromise = app
      .inject({
        method: "POST",
        url: "/broker/gateway/v1/chat/completions",
        headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
        payload: { model: "anthropic/claude-sonnet-4.6", stream: true },
      })
      .finally(() => {
        responseSettled = true;
      });

    await waitUntil(() => spendWriteStarted);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(responseSettled).toBe(false);

    releaseSpendWrite();
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(chunks.join(""));
    expect(spends).toHaveLength(1);
  });

  it("passes upstream errors through and records an unparsed request", async () => {
    const fetchImpl = jsonUpstream({ error: { message: "rate limited" } }, 429);
    const { app, spends } = createBrokerApp({ fetchImpl });

    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "anthropic/claude-sonnet-4.6" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.message).toBe("rate limited");
    await waitForSpend(spends);
    expect(spends[0]).toMatchObject({
      upstreamStatus: 429,
      usageParsed: false,
      costUsdMicros: 0,
    });
  });

  it("502s when the upstream is unreachable and still records the request", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { app, spends } = createBrokerApp({ fetchImpl });

    const response = await app.inject({
      method: "POST",
      url: "/broker/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      payload: { model: "anthropic/claude-sonnet-4.6" },
    });

    expect(response.statusCode).toBe(502);
    expect(spends[0]).toMatchObject({ upstreamStatus: null, usageParsed: false });
  });
});

describe("server integration", () => {
  it("keeps default JSON parsing on /internal/* routes (broker parser is encapsulated)", async () => {
    const { createServer } = await import("./server");
    const { store } = createFakeStore(defaultTokens());
    const server = createServer(env, { llmBroker: { store } });

    const response = await server.inject({
      method: "POST",
      url: "/internal/sessions/session-1/start",
      headers: {
        authorization: "Bearer internal-secret",
        "content-type": "application/json",
      },
      payload: { ignored: true },
    });
    expect(response.statusCode).toBe(202);

    await server.close();
  });
});
