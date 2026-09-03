import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  loadCodexCredential: vi.fn(),
  markCodexCredentialNeedsReauth: vi.fn(),
  releaseCodexCredentialRefreshLock: vi.fn(),
  rotateCodexCredential: vi.fn(),
  tryAcquireCodexCredentialRefreshLock: vi.fn(),
}));

vi.mock("@opencompany/db/codex-auth", () => dbMocks);

import {
  CODEX_BACKEND_CLIENT_VERSION,
  createCodexBackendLanguageModel,
  normalizeCodexRequestBody,
} from "./codex-backend-language-model";

describe("Codex backend language model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.loadCodexCredential.mockResolvedValue(
      credential({
        accessToken: jwt({
          exp: Math.floor(Date.now() / 1_000) + 3_600,
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
        }),
        refreshToken: "refresh-secret",
      }),
    );
  });

  it("sends authenticated Responses requests to the pinned subscription endpoint", async () => {
    const fetchImpl = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      expect(url.origin + url.pathname).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(url.searchParams.get("client_version")).toBe(CODEX_BACKEND_CLIENT_VERSION);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toMatch(/^Bearer /u);
      expect(headers.get("chatgpt-account-id")).toBe("acct_workspace");
      expect(headers.get("openai-beta")).toBe("responses=experimental");
      expect(headers.get("originator")).toBe("opencompany");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "gpt-5.6-sol",
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      expect(body).not.toHaveProperty("max_output_tokens");
      return responsesSuccess();
    });
    const model = createCodexBackendLanguageModel({
      db: {},
      userWorkosId: "user_provider",
      modelId: "openai/gpt-5.6-sol",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await (model as any).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 100,
    } as never);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "hello back" })]),
    );
    expect(dbMocks.tryAcquireCodexCredentialRefreshLock).not.toHaveBeenCalled();
  });

  it("uses the Responses SSE protocol for streaming calls", async () => {
    const fetchImpl = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-5.6-sol",
        store: false,
        stream: true,
      });
      return responsesStream();
    });
    const model = createCodexBackendLanguageModel({
      db: {},
      userWorkosId: "user_provider",
      modelId: "openai/gpt-5.6-sol",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await (model as any).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    } as never);
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text-delta", delta: "streamed back" }),
        expect.objectContaining({ type: "finish", finishReason: { unified: "stop" } }),
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("streams function calls through the Responses adapter", async () => {
    const fetchImpl = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        tools: [expect.objectContaining({ type: "function", name: "lookup_weather" })],
        stream: true,
      });
      return functionCallStream();
    });
    const model = createCodexBackendLanguageModel({
      db: {},
      userWorkosId: "user_provider",
      modelId: "openai/gpt-5.6-terra",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await (model as any).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
      tools: [
        {
          type: "function",
          name: "lookup_weather",
          description: "Look up weather.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    } as never);
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "lookup_weather",
          input: '{"city":"Paris"}',
        }),
      ]),
    );
  });

  it("refreshes an expired token under the database lease and persists rotation", async () => {
    dbMocks.loadCodexCredential.mockResolvedValueOnce(
      credential({
        accessToken: jwt({
          exp: Math.floor(Date.now() / 1_000) - 30,
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
        }),
        refreshToken: "old-refresh-secret",
      }),
    );
    dbMocks.loadCodexCredential.mockResolvedValueOnce(
      credential({
        accessToken: jwt({
          exp: Math.floor(Date.now() / 1_000) - 30,
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
        }),
        refreshToken: "old-refresh-secret",
      }),
    );
    dbMocks.tryAcquireCodexCredentialRefreshLock.mockResolvedValue({
      lockId: "lock_1",
      expiresAt: new Date(Date.now() + 30_000),
    });
    dbMocks.rotateCodexCredential.mockResolvedValue(true);
    const refreshedAccess = jwt({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
    });
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
      if (String(request) === "https://auth.openai.com/oauth/token") {
        return Response.json({
          access_token: refreshedAccess,
          refresh_token: "rotated-refresh-secret",
        });
      }
      return responsesSuccess();
    });
    const model = createCodexBackendLanguageModel({
      db: {},
      userWorkosId: "user_provider",
      modelId: "openai/gpt-5.6-terra",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await (model as any).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    } as never);

    expect(dbMocks.tryAcquireCodexCredentialRefreshLock).toHaveBeenCalledTimes(1);
    expect(dbMocks.rotateCodexCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_provider",
        authJson: expect.objectContaining({
          tokens: expect.objectContaining({
            access_token: refreshedAccess,
            refresh_token: "rotated-refresh-secret",
          }),
        }),
      }),
    );
    expect(dbMocks.releaseCodexCredentialRefreshLock).toHaveBeenCalledWith(
      expect.objectContaining({ lockId: "lock_1" }),
    );
  });

  it("uses a concurrent request's rotated credential instead of refreshing twice", async () => {
    const stale = credential({
      accessToken: jwt({
        exp: Math.floor(Date.now() / 1_000) - 30,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
      }),
      refreshToken: "old-refresh-secret",
    });
    const fresh = {
      ...credential({
        accessToken: jwt({
          exp: Math.floor(Date.now() / 1_000) + 3_600,
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
        }),
        refreshToken: "rotated-refresh-secret",
      }),
      lastRotatedAt: new Date(stale.lastRotatedAt.getTime() + 1_000),
    };
    dbMocks.loadCodexCredential.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    dbMocks.tryAcquireCodexCredentialRefreshLock.mockResolvedValue(null);
    const fetchImpl = vi.fn(async () => responsesSuccess());
    const model = createCodexBackendLanguageModel({
      db: {},
      userWorkosId: "user_provider",
      modelId: "openai/gpt-5.6-sol",
      fetchImpl: fetchImpl as typeof fetch,
      wait: async () => undefined,
    });

    await (model as any).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    } as never);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(dbMocks.rotateCodexCredential).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "network failure",
      refresh: () => Promise.reject(new Error("temporary network failure")),
      message: "could not reach OpenAI",
    },
    {
      name: "service failure",
      refresh: () => Response.json({ error: "server_error" }, { status: 503 }),
      message: "HTTP 503",
    },
  ])(
    "does not invalidate credentials after a transient refresh $name",
    async ({ refresh, message }) => {
      const stale = credential({
        accessToken: jwt({
          exp: Math.floor(Date.now() / 1_000) - 30,
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
        }),
        refreshToken: "old-refresh-secret",
      });
      dbMocks.loadCodexCredential.mockResolvedValue(stale);
      dbMocks.tryAcquireCodexCredentialRefreshLock.mockResolvedValue({
        lockId: "lock_transient",
        expiresAt: new Date(Date.now() + 30_000),
      });
      const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
        if (String(request) === "https://auth.openai.com/oauth/token") return refresh();
        return responsesSuccess();
      });
      const model = createCodexBackendLanguageModel({
        db: {},
        userWorkosId: "user_provider",
        modelId: "openai/gpt-5.6-sol",
        fetchImpl: fetchImpl as typeof fetch,
      });

      await expect(
        (model as any).doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        } as never),
      ).rejects.toThrow(message);
      expect(dbMocks.markCodexCredentialNeedsReauth).not.toHaveBeenCalled();
      expect(dbMocks.releaseCodexCredentialRefreshLock).toHaveBeenCalledWith(
        expect.objectContaining({ lockId: "lock_transient" }),
      );
    },
  );

  it("marks credentials for reauthorization when the refresh grant is invalid", async () => {
    const stale = credential({
      accessToken: jwt({
        exp: Math.floor(Date.now() / 1_000) - 30,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
      }),
      refreshToken: "expired-refresh-secret",
    });
    dbMocks.loadCodexCredential.mockResolvedValue(stale);
    dbMocks.tryAcquireCodexCredentialRefreshLock.mockResolvedValue({
      lockId: "lock_invalid_grant",
      expiresAt: new Date(Date.now() + 30_000),
    });
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) =>
      String(request) === "https://auth.openai.com/oauth/token"
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : responsesSuccess(),
    );
    const model = createCodexBackendLanguageModel({
      db: {},
      userWorkosId: "user_provider",
      modelId: "openai/gpt-5.6-sol",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      (model as any).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      } as never),
    ).rejects.toThrow("reconnect Codex in Settings");
    expect(dbMocks.markCodexCredentialNeedsReauth).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_provider" }),
    );
  });

  it("retries one hard 401 after refresh, marks reauth, and stops", async () => {
    dbMocks.tryAcquireCodexCredentialRefreshLock.mockResolvedValue({
      lockId: "lock_401",
      expiresAt: new Date(Date.now() + 30_000),
    });
    dbMocks.rotateCodexCredential.mockResolvedValue(true);
    const refreshedAccess = jwt({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_workspace" },
    });
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
      if (String(request) === "https://auth.openai.com/oauth/token") {
        return Response.json({ access_token: refreshedAccess, refresh_token: "rotated" });
      }
      return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
    });
    const model = createCodexBackendLanguageModel({
      db: {},
      userWorkosId: "user_provider",
      modelId: "openai/gpt-5.6-sol",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      (model as any).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      } as never),
    ).rejects.toThrow("reconnect Codex in Settings");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(dbMocks.markCodexCredentialNeedsReauth).toHaveBeenCalledWith(
      expect.objectContaining({ userWorkosId: "user_provider" }),
    );
  });

  it("surfaces 429 usage limits and does not attempt another provider", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { message: "upstream limit", type: "rate_limit", code: "rate_limit" } },
        { status: 429, headers: { "retry-after": "60" } },
      ),
    );
    const model = createCodexBackendLanguageModel({
      db: {},
      userWorkosId: "user_provider",
      modelId: "openai/gpt-5.6-sol",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      (model as any).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      } as never),
    ).rejects.toThrow(/ChatGPT usage limit reached.*Retry after 60 seconds/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeCodexRequestBody", () => {
  it("drops server item references and IDs while retaining encrypted reasoning", () => {
    const normalized = normalizeCodexRequestBody(
      JSON.stringify({
        max_output_tokens: 1_000,
        previous_response_id: "resp_server",
        input: [
          { type: "item_reference", id: "item_server" },
          {
            type: "reasoning",
            id: "reasoning_server",
            encrypted_content: "encrypted-continuity",
            summary: [],
          },
        ],
      }),
    );
    expect(JSON.parse(String(normalized))).toEqual({
      store: false,
      include: ["reasoning.encrypted_content"],
      input: [
        {
          type: "reasoning",
          encrypted_content: "encrypted-continuity",
          summary: [],
        },
      ],
    });
  });
});

function credential(input: { accessToken: string; refreshToken: string }) {
  const rotated = new Date("2026-09-01T12:00:00.000Z");
  return {
    authJson: {
      tokens: {
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
      },
    },
    status: "connected" as const,
    statusReason: null,
    lastValidatedAt: rotated,
    lastRotatedAt: rotated,
    updatedAt: rotated,
    encryptionKeyVersion: 1,
    refreshLockId: null,
    refreshLockExpiresAt: null,
  };
}

function jwt(claims: Record<string, unknown>) {
  return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
    JSON.stringify(claims),
  ).toString("base64url")}.signature`;
}

function responsesSuccess() {
  return Response.json({
    id: "resp_1",
    created_at: 1_788_278_400,
    model: "gpt-5.6-sol",
    output: [
      {
        type: "message",
        role: "assistant",
        id: "message_1",
        content: [
          {
            type: "output_text",
            text: "hello back",
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
}

function responsesStream() {
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp_stream",
        created_at: 1_788_278_400,
        model: "gpt-5.6-sol",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "message_stream", phase: "final_answer" },
    },
    {
      type: "response.output_text.delta",
      item_id: "message_stream",
      output_index: 0,
      delta: "streamed back",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "message_stream", phase: "final_answer" },
    },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 3,
          output_tokens_details: { reasoning_tokens: 0 },
        },
        reasoning: null,
        service_tier: null,
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function functionCallStream() {
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp_tool",
        created_at: 1_788_278_400,
        model: "gpt-5.6-terra",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "function_item_1",
        call_id: "call_1",
        name: "lookup_weather",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "function_item_1",
      output_index: 0,
      delta: '{"city":"Paris"}',
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "function_item_1",
        call_id: "call_1",
        name: "lookup_weather",
        arguments: '{"city":"Paris"}',
        status: "completed",
      },
    },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 3,
          output_tokens_details: { reasoning_tokens: 0 },
        },
        reasoning: null,
        service_tier: null,
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
