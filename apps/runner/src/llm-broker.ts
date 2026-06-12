import { Readable } from "node:stream";
import { createLogger } from "@opencompany/observability";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RunnerEnv } from "./env";
import {
  type BrokerProvider,
  type BrokerTokenStore,
  createDbBrokerTokenStore,
  type ValidatedBrokerToken,
  validateBrokerToken,
} from "./llm-broker-tokens";
import {
  type BrokerEndpoint,
  createSseUsageScanner,
  type ParsedBrokerUsage,
  parseJsonUsage,
  priceBrokerRequest,
} from "./llm-broker-usage";

// The runner-hosted LLM broker: an authenticated reverse proxy in front of the model
// providers used by sandboxed CLIs (opencode, codex, the memory CLI). The sandbox only
// ever sees a short-lived per-delegation token (llm-broker-tokens.ts); the real provider
// key is attached here, server-side, and usage is metered per upstream request as the
// billable record. Upstreams are pinned per provider — the client controls nothing about
// where a request goes beyond the allowlisted path.

const logger = createLogger({ service: "opencompany-runner", runtime: "llm-broker" });

const BROKER_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
// Per-upstream-request ceiling. Individual model calls finish well within this; the
// delegation-level wall clock is enforced by the tool timeouts, not the broker.
const UPSTREAM_TIMEOUT_MS = 20 * 60 * 1000;

type Upstream = {
  baseUrl: string;
  apiKey: () => string | undefined;
};

function upstreamFor(provider: BrokerProvider, env: RunnerEnv): Upstream {
  if (provider === "openai") {
    return {
      baseUrl: "https://api.openai.com/v1",
      apiKey: () => env.openaiCodexApiKey,
    };
  }
  return {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    apiKey: () => env.vercelAiGatewayApiKey,
  };
}

// OpenAI-style error envelope so the proxied CLIs surface a readable message instead of
// an opaque HTTP failure.
function sendBrokerError(reply: FastifyReply, status: number, code: string, message: string): void {
  reply
    .status(status)
    .header("content-type", "application/json")
    .send({ error: { message, type: "opencompany_llm_broker_error", code } });
}

export type LlmBrokerOptions = {
  env: RunnerEnv;
  // Test seams: the DB-backed token store and global fetch by default.
  store?: BrokerTokenStore;
  fetchImpl?: typeof fetch;
};

const ENDPOINTS: Array<{ method: "POST" | "GET"; path: string; endpoint: BrokerEndpoint }> = [
  { method: "POST", path: "chat/completions", endpoint: "chat.completions" },
  { method: "POST", path: "embeddings", endpoint: "embeddings" },
  { method: "POST", path: "responses", endpoint: "responses" },
  { method: "GET", path: "models", endpoint: "models" },
];

export function registerLlmBrokerRoutes(
  instance: FastifyInstance,
  options: LlmBrokerOptions,
): void {
  const store = options.store ?? createDbBrokerTokenStore();
  const fetchImpl = options.fetchImpl ?? fetch;

  // The broker forwards bodies verbatim, so parse everything in this encapsulated scope
  // as a raw buffer. /internal/* routes live outside this plugin and keep Fastify's
  // default JSON parser.
  instance.removeAllContentTypeParsers();
  instance.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: BROKER_BODY_LIMIT_BYTES },
    (_request, body, done) => done(null, body),
  );

  for (const route of ENDPOINTS) {
    const url = `/broker/:provider/v1/${route.path}`;
    const handler = (request: FastifyRequest, reply: FastifyReply) =>
      handleBrokerRequest({
        request,
        reply,
        endpoint: route.endpoint,
        env: options.env,
        store,
        fetchImpl,
      });
    if (route.method === "POST") {
      instance.post(url, { bodyLimit: BROKER_BODY_LIMIT_BYTES }, handler);
    } else {
      instance.get(url, handler);
    }
  }
}

function parseProvider(value: unknown): BrokerProvider | null {
  return value === "gateway" || value === "openai" ? value : null;
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function tokenAllowsEndpoint(token: ValidatedBrokerToken, endpoint: BrokerEndpoint): boolean {
  switch (token.toolName) {
    case "codex_coder":
      return endpoint === "responses" || endpoint === "models";
    case "opencode_coder":
      return endpoint === "chat.completions" || endpoint === "models";
    case "memory":
      return endpoint === "chat.completions" || endpoint === "embeddings";
    default:
      return false;
  }
}

async function handleBrokerRequest(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  endpoint: BrokerEndpoint;
  env: RunnerEnv;
  store: BrokerTokenStore;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const { request, reply, endpoint, env, store, fetchImpl } = input;

  const provider = parseProvider((request.params as { provider?: string }).provider);
  if (!provider) {
    return sendBrokerError(reply, 404, "unknown_provider", "Unknown broker provider.");
  }

  const rawToken = bearerToken(request.headers.authorization);
  if (!rawToken) {
    return sendBrokerError(reply, 401, "missing_token", "A broker token is required.");
  }
  const token = await validateBrokerToken(rawToken, store);
  if (!token) {
    return sendBrokerError(
      reply,
      403,
      "invalid_token",
      "The broker token is unknown, expired, or revoked.",
    );
  }
  if (token.provider !== provider) {
    return sendBrokerError(
      reply,
      403,
      "provider_mismatch",
      "The broker token is not valid for this provider.",
    );
  }
  if (!tokenAllowsEndpoint(token, endpoint)) {
    return sendBrokerError(
      reply,
      403,
      "endpoint_not_allowed",
      "The broker token is not valid for this endpoint.",
    );
  }
  if (token.budgetUsdMicros != null && token.spentUsdMicros >= token.budgetUsdMicros) {
    return sendBrokerError(
      reply,
      402,
      "budget_exhausted",
      "The delegation budget for this broker token is exhausted.",
    );
  }

  const upstream = upstreamFor(provider, env);
  const upstreamKey = upstream.apiKey();
  if (!upstreamKey) {
    return sendBrokerError(
      reply,
      503,
      "upstream_not_configured",
      "No upstream credential is configured for this provider.",
    );
  }

  // Read the request body (raw buffer from the broker-scope parser). For POST
  // endpoints, parse it to extract the model and stream flag, and inject
  // stream_options.include_usage on streamed chat completions so the final chunk
  // always carries usage regardless of client behaviour.
  let body: string | undefined;
  let model: string | null = null;
  let streamRequested = false;
  if (request.method === "POST") {
    const rawBody = request.body;
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : "";
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("not an object");
      }
      parsed = value as Record<string, unknown>;
    } catch {
      return sendBrokerError(reply, 400, "invalid_body", "The request body must be JSON.");
    }
    model = typeof parsed.model === "string" ? parsed.model : null;
    streamRequested = parsed.stream === true;
    if (endpoint === "chat.completions" && streamRequested) {
      const streamOptions =
        parsed.stream_options && typeof parsed.stream_options === "object"
          ? (parsed.stream_options as Record<string, unknown>)
          : {};
      parsed.stream_options = { ...streamOptions, include_usage: true };
    }
    body = JSON.stringify(parsed);
  }

  const startedAt = Date.now();
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchImpl(`${upstream.baseUrl}/${brokerPathFor(endpoint)}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${upstreamKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        accept: typeof request.headers.accept === "string" ? request.headers.accept : "*/*",
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("LLM broker upstream request failed", {
      event: "opencompany.llm_broker_upstream_failed",
      provider,
      endpoint,
      session_id: token.sessionId,
      error,
    });
    await recordSpendSafely(store, {
      token,
      endpoint,
      model,
      streamed: streamRequested,
      upstreamStatus: null,
      usage: null,
      latencyMs: Date.now() - startedAt,
    });
    return sendBrokerError(reply, 502, "upstream_unreachable", "The upstream request failed.");
  }

  // /models carries no usage — pass it through without metering noise.
  if (endpoint === "models") {
    const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
    reply
      .status(upstreamResponse.status)
      .header("content-type", upstreamResponse.headers.get("content-type") ?? "application/json")
      .send(responseBody);
    return;
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
  const isEventStream = contentType.includes("text/event-stream");

  if (!upstreamResponse.body || !isEventStream) {
    // Non-streaming (or empty/error) response: buffer, meter, forward verbatim.
    const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
    const usage = upstreamResponse.ok
      ? parseJsonUsage(safeJsonParse(responseBuffer.toString("utf8")))
      : null;
    await recordSpendSafely(store, {
      token,
      endpoint,
      model,
      streamed: false,
      upstreamStatus: upstreamResponse.status,
      usage,
      latencyMs: Date.now() - startedAt,
    });
    reply.status(upstreamResponse.status).header("content-type", contentType).send(responseBuffer);
    return;
  }

  // Streaming: tee the upstream body — one branch feeds the client untouched, the other
  // feeds the usage scanner. Metering must never block or fail the proxied stream.
  const [clientBranch, meterBranch] = upstreamResponse.body.tee();
  void scanStreamUsage(meterBranch)
    .then((usage) =>
      recordSpendSafely(store, {
        token,
        endpoint,
        model,
        streamed: true,
        upstreamStatus: upstreamResponse.status,
        usage,
        latencyMs: Date.now() - startedAt,
      }),
    )
    .catch((error) => {
      logger.warn("LLM broker stream metering failed", {
        event: "opencompany.llm_broker_metering_failed",
        provider,
        endpoint,
        session_id: token.sessionId,
        error,
      });
    });

  reply
    .status(upstreamResponse.status)
    .header("content-type", contentType)
    .header("cache-control", "no-cache");
  return reply.send(Readable.fromWeb(clientBranch as Parameters<typeof Readable.fromWeb>[0]));
}

function brokerPathFor(endpoint: BrokerEndpoint): string {
  switch (endpoint) {
    case "chat.completions":
      return "chat/completions";
    case "embeddings":
      return "embeddings";
    case "responses":
      return "responses";
    case "models":
      return "models";
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function scanStreamUsage(stream: ReadableStream<Uint8Array>): Promise<ParsedBrokerUsage> {
  const scanner = createSseUsageScanner();
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    scanner.push(decoder.decode(value, { stream: true }));
  }
  scanner.push(decoder.decode());
  return scanner.finish();
}

async function recordSpendSafely(
  store: BrokerTokenStore,
  input: {
    token: ValidatedBrokerToken;
    endpoint: BrokerEndpoint;
    model: string | null;
    streamed: boolean;
    upstreamStatus: number | null;
    usage: ParsedBrokerUsage | null;
    latencyMs: number;
  },
): Promise<void> {
  const usage = input.usage;
  const costUsdMicros = usage?.parsed
    ? priceBrokerRequest({ provider: input.token.provider, model: input.model, usage })
    : 0;
  try {
    await store.recordSpend({
      tokenId: input.token.id,
      sessionId: input.token.sessionId,
      endpoint: input.endpoint,
      model: input.model,
      streamed: input.streamed,
      upstreamStatus: input.upstreamStatus,
      inputTokens: usage?.inputTokens ?? 0,
      inputCacheReadTokens: usage?.inputCacheReadTokens ?? 0,
      inputCacheWriteTokens: usage?.inputCacheWriteTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costUsdMicros,
      usageParsed: usage?.parsed ?? false,
      latencyMs: input.latencyMs,
      rawUsage: usage?.raw ?? {},
    });
  } catch (error) {
    // Metering failures must never fail the proxied response; the settlement sweeper
    // and the unparsed counter exist to keep these visible.
    logger.error("LLM broker failed to record spend", {
      event: "opencompany.llm_broker_record_spend_failed",
      session_id: input.token.sessionId,
      token_id: input.token.id,
      endpoint: input.endpoint,
      error,
    });
  }
}
