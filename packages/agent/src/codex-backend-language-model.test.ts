import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexUsageLimitError,
  createCodexBackendLanguageModel,
} from "./codex-backend-language-model";

const authMocks = vi.hoisted(() => ({
  loadFresh: vi.fn(),
  markNeedsReauth: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/codex-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadFreshCodexAccessToken: authMocks.loadFresh,
  markCodexCredentialNeedsReauth: authMocks.markNeedsReauth,
}));

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.loadFresh.mockResolvedValue({
    accessToken: "access-one",
    accountId: "account-one",
    expiresAt: null,
  });
});

describe("Codex backend language model", () => {
  it("sends a stateless Responses request and projects encrypted reasoning from SSE", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: new URL(String(url)), init: init ?? {} });
      return sseResponse([
        { type: "response.created", response: { id: "resp_1", model: "gpt-5.6-sol" } },
        { type: "response.output_item.added", item: { type: "reasoning", id: "reason_1" } },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reason_1",
          delta: "Checked context.",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "reason_1",
            encrypted_content: "encrypted-next-turn",
          },
        },
        { type: "response.output_text.delta", item_id: "message_1", delta: "Done." },
        { type: "response.output_text.done", item_id: "message_1" },
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "function_1", call_id: "call_1", name: "lookup" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "function_1",
          delta: '{"query":"opencompany"}',
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "function_1",
          arguments: '{"query":"opencompany"}',
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [{ type: "function_call" }],
            usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
          },
        },
      ]);
    });
    const model = createCodexBackendLanguageModel({
      modelId: "openai/gpt-5.6-sol",
      providerUserWorkosId: "user_provider",
      db: {},
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await model.doStream({
      prompt: [
        { role: "system", content: "System instructions" },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Prior summary",
              providerOptions: { codex: { encryptedContent: "encrypted-prior-turn" } },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Continue" }] },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look something up",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    } as never);
    const parts = await readStream(result.stream);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/backend-api/codex/responses");
    expect(requests[0]?.url.searchParams.get("client_version")).toBe("0.148.0");
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: "Bearer access-one",
      "chatgpt-account-id": "account-one",
      "OpenAI-Beta": "responses=experimental",
    });
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      instructions: "System instructions",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    });
    expect(JSON.stringify(body)).toContain("encrypted-prior-turn");
    expect(body.tools).toEqual([
      expect.objectContaining({ type: "function", name: "lookup", strict: false }),
    ]);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(parts).toContainEqual({
      type: "reasoning-end",
      id: "reason_1",
      providerMetadata: { codex: { encryptedContent: "encrypted-next-turn" } },
    });
    expect(parts).toContainEqual({ type: "text-delta", id: "message_1", delta: "Done." });
    expect(parts).toContainEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "lookup",
      input: '{"query":"opencompany"}',
    });
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "finish",
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 5, totalTokens: 17 }),
      }),
    );
  });

  it("refreshes once after a 401 and retries without falling back", async () => {
    authMocks.loadFresh
      .mockResolvedValueOnce({ accessToken: "rejected", accountId: "account-one", expiresAt: null })
      .mockResolvedValueOnce({
        accessToken: "refreshed",
        accountId: "account-one",
        expiresAt: null,
      });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        sseResponse([
          {
            type: "response.completed",
            response: { status: "completed", output: [], usage: {} },
          },
        ]),
      );
    const model = createCodexBackendLanguageModel({
      modelId: "openai/gpt-5.6-terra",
      providerUserWorkosId: "user_provider",
      db: {},
      fetchImpl: fetchImpl as typeof fetch,
    });

    await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    } as never);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(authMocks.loadFresh).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ rejectedAccessToken: "rejected" }),
    );
  });

  it("surfaces ChatGPT usage limits as a route-specific error", async () => {
    const model = createCodexBackendLanguageModel({
      modelId: "openai/gpt-5.6-sol",
      providerUserWorkosId: "user_provider",
      db: {},
      fetchImpl: vi.fn(
        async () => new Response(null, { status: 429, headers: { "retry-after": "10 minutes" } }),
      ) as typeof fetch,
    });

    await expect(
      model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      } as never),
    ).rejects.toEqual(expect.any(CodexUsageLimitError));
  });

  it("marks the designation for reconnect when a refreshed token is also rejected", async () => {
    authMocks.loadFresh
      .mockResolvedValueOnce({ accessToken: "rejected", accountId: "account-one", expiresAt: null })
      .mockResolvedValueOnce({
        accessToken: "still-rejected",
        accountId: "account-one",
        expiresAt: null,
      });
    const model = createCodexBackendLanguageModel({
      modelId: "openai/gpt-5.6-sol",
      providerUserWorkosId: "user_provider",
      db: {},
      fetchImpl: vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch,
    });

    await expect(
      model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      } as never),
    ).rejects.toMatchObject({ name: "CodexCredentialNeedsReauthError" });
    expect(authMocks.markNeedsReauth).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_provider" }),
    );
  });

  it("replaces network failures so bearer tokens cannot escape through errors", async () => {
    const model = createCodexBackendLanguageModel({
      modelId: "openai/gpt-5.6-sol",
      providerUserWorkosId: "user_provider",
      db: {},
      fetchImpl: vi.fn(async () => {
        throw new Error("request failed with Bearer access-one");
      }) as typeof fetch,
    });

    const failure = await Promise.resolve(
      model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      } as never),
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "CodexApiError",
      message: "Codex API error. Try again or switch models.",
    });
    expect(String(failure)).not.toContain("access-one");
  });
});

function sseResponse(events: Record<string, unknown>[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function readStream<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader();
  const values: T[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return values;
    values.push(value);
  }
}
