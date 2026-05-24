import {
  RUNTIME_TOOL_DEFINITION_BY_NAME,
  type RuntimeToolDefinition,
} from "@opencompany/agent-runtime";
import {
  agentSessionMessages,
  agentSessions,
  agentSessionToolUsage,
  agentSessionUsage,
} from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireRunLease,
  appendRuntimeEventForLease,
  completeAssistantMessageForLease,
  createAssistantMessageForLease,
  executeRuntimeTool,
  normalizeReasoningSummary,
  readReasoningTextDelta,
  recordStepUsage,
  recordToolUsage,
  throwIfStreamErrorPart,
} from "./agent-loop";
import type { RunnerEnv } from "./env";
import { appendRuntimeEvent } from "./events";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

const observabilityMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: dbMocks.getDb,
}));

vi.mock("@opencompany/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/observability")>();
  return {
    ...actual,
    captureException: observabilityMocks.captureException,
  };
});

vi.mock("./events", () => ({
  appendRuntimeEvent: vi.fn(async () => ({ id: 1 })),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("run lease acquisition", () => {
  it("blocks acquisition while a non-expired lease is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    const db = createLeaseDb({
      runLeaseId: "run_active",
      runLeaseExpiresAt: new Date("2026-05-22T12:05:00.000Z"),
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      acquireRunLease({
        sessionId: "ses_123",
        messageId: "msg_user",
        leaseId: "run_next",
        leaseOwner: "runner-test",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
      }),
    ).resolves.toBe(false);

    expect(db.state.session.runLeaseId).toBe("run_active");
  });

  it("replaces an expired lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));
    const db = createLeaseDb({
      runLeaseId: "run_stale",
      runLeaseExpiresAt: new Date("2026-05-22T11:59:00.000Z"),
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      acquireRunLease({
        sessionId: "ses_123",
        messageId: "msg_user",
        leaseId: "run_next",
        leaseOwner: "runner-test",
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
      }),
    ).resolves.toBe(true);

    expect(db.state.session.runLeaseId).toBe("run_next");
    expect(db.state.session.runLeaseOwner).toBe("runner-test");
    expect(db.state.session.runLeaseMessageId).toBe("msg_user");
    expect(db.state.session.runLeaseExpiresAt).toEqual(new Date("2026-05-22T12:15:00.000Z"));
  });
});

describe("lease-guarded writes", () => {
  it("deduplicates assistant responses for the same user message", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      createAssistantMessageForLease({
        id: "msg_assistant_1",
        sessionId: "ses_123",
        responseToMessageId: "msg_user",
        leaseId: "run_123",
        leaseOwner: "runner-test",
      }),
    ).resolves.toBe(true);
    await expect(
      createAssistantMessageForLease({
        id: "msg_assistant_2",
        sessionId: "ses_123",
        responseToMessageId: "msg_user",
        leaseId: "run_123",
        leaseOwner: "runner-test",
      }),
    ).resolves.toBe(false);

    expect(db.state.messages).toHaveLength(1);
    expect(db.state.messages[0]).toMatchObject({
      id: "msg_assistant_1",
      responseToMessageId: "msg_user",
    });
    expect(appendRuntimeEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects event writes under the wrong lease", async () => {
    const db = createLeaseDb({ runLeaseId: "run_current" });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      appendRuntimeEventForLease({
        sessionId: "ses_123",
        leaseId: "run_stale",
        leaseOwner: "runner-test",
        type: "session.status",
        payload: { status: "running" },
      }),
    ).resolves.toBe(false);

    expect(appendRuntimeEvent).not.toHaveBeenCalled();
  });

  it("rejects assistant completion under the wrong lease", async () => {
    const db = createLeaseDb({
      runLeaseId: "run_current",
      messages: [{ id: "msg_assistant", sessionId: "ses_123", status: "running" }],
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      completeAssistantMessageForLease({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        leaseId: "run_stale",
        leaseOwner: "runner-test",
        content: "done",
        modelMessage: { role: "assistant", content: "done" },
      }),
    ).rejects.toThrow("Run lease is no longer current.");

    expect(db.state.messages[0]?.status).toBe("running");
  });
});

describe("usage recording", () => {
  it("records model usage with sequential step indexes", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await recordStepUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      stepIndex: 1,
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      response: {
        id: "response_1",
        timestamp: new Date("2026-05-22T12:00:00.000Z"),
        modelId: "openai/gpt-5.4-mini",
      },
      usage: usage(100, 20),
      finishReason: "tool-calls",
      rawFinishReason: undefined,
    });
    await recordStepUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      stepIndex: 2,
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      response: {
        id: "response_2",
        timestamp: new Date("2026-05-22T12:00:01.000Z"),
        modelId: "openai/gpt-5.4-mini",
      },
      usage: usage(80, 30),
      finishReason: "stop",
      rawFinishReason: undefined,
    });

    expect(db.state.usage.map((row) => row.stepIndex)).toEqual([1, 2]);
    expect(db.state.ledgerDebits).toBe(2);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.usage",
        payload: expect.objectContaining({ stepIndex: 1 }),
      }),
    );
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.usage",
        payload: expect.objectContaining({ stepIndex: 2 }),
      }),
    );
  });

  it("records hosted tool usage and emits usage events", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    await recordToolUsage({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      toolCallId: "call_exa",
      toolName: "exa_search",
      usage: {
        provider: "exa",
        operation: "search",
        providerRequestId: "exa_req_123",
        costUsdMicros: 7000,
        rawUsage: { costDollars: { total: 0.007 } },
      },
    });

    expect(db.state.toolUsage).toEqual([
      expect.objectContaining({
        toolCallId: "call_exa",
        toolName: "exa_search",
        provider: "exa",
        operation: "search",
        providerRequestId: "exa_req_123",
        costUsdMicros: 7000,
      }),
    ]);
    expect(db.state.ledgerDebits).toBe(1);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.tool_usage",
        payload: expect.objectContaining({
          toolCallId: "call_exa",
          provider: "exa",
          costUsdMicros: 7000,
        }),
      }),
    );
  });

  it("executes hosted tools without hydrating the sandbox", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              requestId: "exa_req_123",
              searchType: "auto",
              costDollars: { total: 0.001 },
              results: [],
            }),
            { status: 200 },
          ),
      ),
    );
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: agentConfig(),
      toolCallId: "call_exa",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
      args: { query: "test" },
      getSandbox,
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["tool_help", "exa_search"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(db.state.toolUsage).toHaveLength(1);
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "exa_search",
      toolCallId: "call_exa",
    });
  });

  it("captures hosted Exa validation failures with searchable monitoring context", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        agentConfig: agentConfig(),
        toolCallId: "call_exa",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
        args: {
          query: "OpenAI leadership",
          category: "people",
          excludeDomains: ["example.com"],
          startPublishedDate: "2026-01-01",
        },
        getSandbox,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["tool_help", "exa_search"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
        observabilityContext: {
          workspaceId: "wsp_123",
          userId: "user_123",
          agentId: "agt_123",
          modelProvider: "vercel-ai-gateway",
          modelName: "openai/gpt-5.4-mini",
        },
      }),
    ).rejects.toThrow(
      "Exa company and people category searches do not support excludeDomains or published date filters.",
    );

    expect(getSandbox).not.toHaveBeenCalled();
    expect(observabilityMocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: "opencompany.runner_tool_failed",
        workspace_id: "wsp_123",
        user_id: "user_123",
        agent_id: "agt_123",
        session_id: "ses_123",
        message_id: "msg_assistant",
        tool_call_id: "call_exa",
        tool_name: "exa_search",
        tool_kind: "hosted",
        model_provider: "vercel-ai-gateway",
        model_name: "openai/gpt-5.4-mini",
        hosted_provider: "exa",
        hosted_operation: "search",
        tool_error_stage: "request_validation",
        tool_error_code: "exa_unsupported_category_filter_combination",
        exa_category: "people",
        exa_has_exclude_domains: true,
        exa_has_published_date_filter: true,
      }),
    );
    expect(db.state.toolUsage).toHaveLength(0);
    expect(db.state.messages).toHaveLength(0);
  });
});

describe("stream error handling", () => {
  it("throws model stream errors instead of allowing blank completions", () => {
    expect(() =>
      throwIfStreamErrorPart({ type: "error", error: new Error("gateway failed") } as never),
    ).toThrow("gateway failed");
  });

  it("throws tool stream errors with a fallback message", () => {
    expect(() =>
      throwIfStreamErrorPart({
        type: "tool-error",
        toolName: "list_files",
        toolCallId: "tool_123",
        input: {},
        error: null,
      } as never),
    ).toThrow("Tool list_files failed.");
  });
});

describe("reasoning stream helpers", () => {
  it("reads reasoning parts without treating them as assistant text", () => {
    expect(readReasoningTextDelta({ type: "reasoning", text: "Reviewed constraints." })).toBe(
      "Reviewed constraints.",
    );
    expect(readReasoningTextDelta({ type: "reasoning-delta", delta: "Checked files." })).toBe(
      "Checked files.",
    );
    expect(readReasoningTextDelta({ type: "text-delta", text: "Visible answer." })).toBe("");
  });

  it("normalizes empty and repeated-newline reasoning summaries", () => {
    expect(normalizeReasoningSummary("")).toBe("");
    expect(normalizeReasoningSummary("  A\n\n\n\nB  ")).toBe("A\n\nB");
  });
});

type MessageState = {
  id: string;
  sessionId: string;
  status?: string;
  responseToMessageId?: string | null;
};

type UsageState = {
  id: number;
  stepIndex: number;
};

type ToolUsageState = {
  id: number;
  toolCallId: string;
  toolName: string;
  provider: string;
  operation: string;
  providerRequestId?: string | null;
  costUsdMicros: number;
};

function createLeaseDb(input: {
  runLeaseId?: string | null;
  runLeaseExpiresAt?: Date | null;
  messages?: MessageState[];
}) {
  const state = {
    session: {
      id: "ses_123",
      archivedAt: null as Date | null,
      runLeaseId: input.runLeaseId ?? null,
      runLeaseOwner: input.runLeaseId ? "runner-test" : null,
      runLeaseMessageId: null as string | null,
      runLeaseExpiresAt: input.runLeaseExpiresAt ?? null,
    },
    messages: [...(input.messages ?? [])],
    usage: [] as UsageState[],
    toolUsage: [] as ToolUsageState[],
    ledgerDebits: 0,
  };

  return {
    state,
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                async returning() {
                  if (table === agentSessions) {
                    if (typeof values.runLeaseId === "string") {
                      const expiresAt = state.session.runLeaseExpiresAt;
                      const canAcquire =
                        !state.session.archivedAt &&
                        (!state.session.runLeaseId || (expiresAt && expiresAt <= new Date()));
                      if (!canAcquire) return [];
                      Object.assign(state.session, values);
                      return [{ id: state.session.id, leaseId: state.session.runLeaseId }];
                    }

                    Object.assign(state.session, values);
                    return [{ id: state.session.id }];
                  }

                  if (table === agentSessionMessages) {
                    const message = state.messages.find(
                      (item) => item.id === values.id || item.id === "msg_assistant",
                    );
                    if (!message) return [];
                    Object.assign(message, values);
                    return [{ id: message.id }];
                  }

                  return [];
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                async limit() {
                  if (table === agentSessions && state.session.runLeaseId === "run_123") {
                    return [{ id: state.session.id }];
                  }
                  if (table === agentSessions && state.session.runLeaseId === "run_current") {
                    return [];
                  }
                  if (table === agentSessions) return [{ id: state.session.id }];
                  return [];
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          if (table === agentSessionUsage) {
            const row = { id: state.usage.length + 1, ...values } as UsageState;
            state.usage.push(row);
            return {
              async returning() {
                return [{ id: row.id }];
              },
            };
          }
          if (table === agentSessionToolUsage) {
            const row = { id: state.toolUsage.length + 1, ...values } as ToolUsageState;
            state.toolUsage.push(row);
            return {
              async returning() {
                return [{ id: row.id }];
              },
            };
          }

          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  if (table !== agentSessionMessages) return [];
                  if (
                    state.messages.some(
                      (message) => message.responseToMessageId === values.responseToMessageId,
                    )
                  ) {
                    return [];
                  }
                  state.messages.push(values as MessageState);
                  return [{ id: values.id }];
                },
              };
            },
            async returning() {
              state.messages.push(values as MessageState);
              return [{ id: values.id }];
            },
          };
        },
      };
    },
    async execute() {
      state.ledgerDebits += 1;
      return { rows: [{ ledgerId: state.ledgerDebits, balanceUsdMicros: 100_000 }] };
    },
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "vag",
    exaApiKey: "exa_test",
    ampApiKey: "amp_test",
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner-test",
    ...overrides,
  };
}

function agentConfig() {
  return {
    version: 2 as const,
    title: "Test agent",
    instructions: "Test.",
    model: {
      provider: "vercel-ai-gateway" as const,
      name: "openai/gpt-5.4-mini" as const,
    },
    tools: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: undefined,
    },
    totalTokens: inputTokens + outputTokens,
  };
}
