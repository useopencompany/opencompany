import type { GoatHarnessSpec, GoatTaskDebugTrace, goatTasks } from "@opencompany/db/goat-schema";
import { describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import type { GoatTaskExecutorInput } from "./goat-harness";
import {
  claimNextGoatTask,
  GOAT_TASK_HEARTBEAT_INTERVAL_MS,
  type GoatTaskStore,
  runClaimedGoatTask,
} from "./goat-worker";

type GoatTask = typeof goatTasks.$inferSelect;

const telemetry = vi.hoisted(() => ({
  recordGoatModelCost: vi.fn(),
  recordGoatTaskRun: vi.fn(),
  recordGoatHistogram: vi.fn(),
  startGoatSpan: vi.fn(() => ({
    setAttributes: vi.fn(),
    runInContext: vi.fn((run: () => unknown) => run()),
    fail: vi.fn(() => "unknown"),
    end: vi.fn(),
  })),
  withGoatSpan: vi.fn(async (_name: string, _attributes: unknown, run: () => Promise<unknown>) =>
    run(),
  ),
}));

const analytics = vi.hoisted(() => ({
  captureGoatModelSpendRecorded: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatModelSpendRecorded: analytics.captureGoatModelSpendRecorded,
}));

vi.mock("@opencompany/goat-observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/goat-observability")>();
  return {
    ...actual,
    recordGoatModelCost: telemetry.recordGoatModelCost,
    recordGoatTaskRun: telemetry.recordGoatTaskRun,
    recordGoatHistogram: telemetry.recordGoatHistogram,
    startGoatSpan: telemetry.startGoatSpan,
    withGoatSpan: telemetry.withGoatSpan,
  };
});

const harnessSpec: GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1",
  engine: "opencompany",
  model: "openai/gpt-5.4-mini",
  systemPrompt: "Run the task.",
  initialUserMessage: "Research Marseille",
  tools: ["exa_search"],
  skills: [],
  maxModelSteps: 8,
  resultMode: "assistant_final",
};

const debugTrace: GoatTaskDebugTrace = {
  schemaVersion: "goat.debug.v1",
  planner: {
    model: "openai/gpt-5.4-mini",
    response: { content: JSON.stringify(harnessSpec) },
  },
  harness: {
    model: "openai/gpt-5.4-mini",
    turns: [{ step: 0, responseMessage: { role: "assistant", content: "Done." } }],
  },
};

describe("claimNextGoatTask", () => {
  it("claims through the store with a fresh lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const store = createStore();
      const claimedTask = task({ leaseId: "lease_claimed" });
      vi.mocked(store.claimNext).mockResolvedValueOnce(claimedTask);

      await expect(
        claimNextGoatTask({
          leaseOwner: "runner_1",
          store,
          leaseTtlMs: 60_000,
        }),
      ).resolves.toBe(claimedTask);

      expect(store.claimNext).toHaveBeenCalledWith({
        leaseId: expect.stringMatching(/^goat_task_/),
        leaseOwner: "runner_1",
        now: new Date("2026-01-01T00:00:00.000Z"),
        leaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runClaimedGoatTask", () => {
  it("heartbeats stage updates and stores successful results", async () => {
    const store = createStore();
    const executor = vi.fn(async (input: GoatTaskExecutorInput) => {
      await input.reportStage("running", { harnessSpec, debugTrace });
      return {
        result: "Done.",
        harnessSpec,
        debugTrace,
      };
    });

    await runClaimedGoatTask({
      task: task(),
      env: env(),
      store,
      executor,
    });

    expect(store.listConversationMessages).toHaveBeenCalledWith({
      id: "goat_task_1",
      leaseId: "lease_1",
      leaseOwner: "runner_1",
    });
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationMessages: [{ role: "user", content: "Research Marseille" }],
      }),
    );
    expect(store.updateStage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_task_1",
        stage: "running",
        debugTrace,
      }),
    );
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_task_1",
        result: "Done.",
        debugTrace,
      }),
    );
    expect(telemetry.recordGoatTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        attributes: expect.objectContaining({
          "goat.task_id": "goat_task_1",
          "goat.status": "succeeded",
        }),
      }),
    );
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("preserves streamed harness debug when the final result only includes planner debug", async () => {
    const store = createStore();
    const plannerOnlyTrace: GoatTaskDebugTrace = {
      schemaVersion: "goat.debug.v1",
      planner: {
        model: "openai/gpt-5.4-mini",
        response: { content: JSON.stringify(harnessSpec) },
      },
    };
    const executor = vi.fn(async (input: GoatTaskExecutorInput) => {
      await input.reportStage("running", { harnessSpec, debugTrace });
      return {
        result: "Done.",
        harnessSpec,
        debugTrace: plannerOnlyTrace,
      };
    });

    await runClaimedGoatTask({
      task: task(),
      env: env(),
      store,
      executor,
    });

    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "Done.",
        debugTrace,
      }),
    );
  });

  it("prices usage records before writing them through the store", async () => {
    const store = createStore();
    const executor = vi.fn(async (input: GoatTaskExecutorInput) => {
      await input.sink.recordModelUsage({
        messageId: "assistant_msg_1",
        phase: "execution",
        stepIndex: 0,
        modelProvider: "vercel-ai-gateway",
        modelName: "openai/gpt-5.4-mini",
        usage: {
          inputTokens: 1_000,
          outputTokens: 100,
          totalTokens: 1_100,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: undefined,
          },
        },
      });
      await input.sink.recordToolUsage({
        messageId: "tool_msg_1",
        toolCallId: "call_search",
        toolName: "exa_search",
        usage: {
          provider: "exa",
          operation: "search",
          providerRequestId: "exa_req_1",
          costUsdMicros: 1_000,
          rawUsage: { requestId: "exa_req_1" },
        },
      });
      await input.sink.recordSandboxUsage({
        messageId: "assistant_msg_1",
        sandboxId: "sbx_1",
        template: "goat",
        vcpu: 2,
        ramMib: 512,
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        endedAt: new Date("2026-01-01T00:00:10.000Z"),
        activeMs: 10_000,
      });
      return {
        result: "Done.",
        harnessSpec,
        debugTrace,
      };
    });

    await runClaimedGoatTask({
      task: task(),
      env: env(),
      store,
      executor,
    });

    expect(store.recordModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_task_1",
        leaseId: "lease_1",
        messageId: "assistant_msg_1",
        phase: "execution",
        stepIndex: 0,
        usage: expect.objectContaining({
          inputTokens: 1_000,
          outputTokens: 100,
          totalTokens: 1_100,
        }),
        cost: expect.objectContaining({
          providerCostUsdMicros: expect.any(Number),
          platformFeeUsdMicros: expect.any(Number),
          totalCostUsdMicros: expect.any(Number),
          costBasis: expect.objectContaining({ kind: "model_usage" }),
        }),
      }),
    );
    expect(telemetry.recordGoatModelCost).toHaveBeenCalledWith({
      costUsdMicros: expect.any(Number),
      attributes: {
        "goat.model": "openai/gpt-5.4-mini",
        "goat.surface": "task",
      },
    });
    expect(analytics.captureGoatModelSpendRecorded).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        billingSource: "task_model_usage",
        surface: "task",
        model: "openai/gpt-5.4-mini",
        stage: "execution",
        providerCostUsdMicros: expect.any(Number),
        platformFeeUsdMicros: expect.any(Number),
        totalCostUsdMicros: expect.any(Number),
        modelCostUsdMicros: expect.any(Number),
        taskId: "goat_task_1",
        messageId: "assistant_msg_1",
      }),
    );
    expect(store.recordToolUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "call_search",
        toolName: "exa_search",
        provider: "exa",
        operation: "search",
        providerRequestId: "exa_req_1",
        cost: expect.objectContaining({
          providerCostUsdMicros: 1_000,
          platformFeeUsdMicros: 200,
          totalCostUsdMicros: 1_200,
          costBasis: expect.objectContaining({ kind: "tool_usage" }),
        }),
      }),
    );
    expect(store.recordSandboxUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_1",
        template: "goat",
        activeMs: 10_000,
        cost: expect.objectContaining({
          providerCostUsdMicros: expect.any(Number),
          platformFeeUsdMicros: expect.any(Number),
          totalCostUsdMicros: expect.any(Number),
          costBasis: expect.objectContaining({ kind: "sandbox_usage" }),
        }),
      }),
    );
  });

  it("persists Codex engine session ids through the active task lease", async () => {
    const store = createStore();
    const executor = vi.fn(async (input: GoatTaskExecutorInput) => {
      await input.sink.updateCodexEngineSessionId("thread_123");
      return {
        result: "Done.",
        harnessSpec,
        debugTrace,
      };
    });

    await runClaimedGoatTask({
      task: task(),
      env: env(),
      store,
      executor,
    });

    expect(store.updateCodexEngineSessionId).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_task_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        codexEngineSessionId: "thread_123",
      }),
    );
  });

  it("persists completed user handoff messages and their creation event", async () => {
    const store = createStore();
    const executor = vi.fn(async (input: GoatTaskExecutorInput) => {
      await input.sink.createUserMessage({ content: "Step 2/2 — Draft the update" });
      return {
        result: "Done.",
        harnessSpec,
        debugTrace,
      };
    });

    await runClaimedGoatTask({
      task: task(),
      env: env(),
      store,
      executor,
    });

    expect(store.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_task_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        role: "user",
        status: "completed",
        content: "Step 2/2 — Draft the update",
        modelMessage: {
          role: "user",
          content: "Step 2/2 — Draft the update",
        },
      }),
    );
    const handoffMessageId = vi.mocked(store.createMessage).mock.calls[0]?.[0].messageId;
    expect(store.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_task_1",
        messageId: handoffMessageId,
        type: "message.created",
        payload: { role: "user", status: "completed" },
      }),
    );
  });

  it("aborts without completing when heartbeat loses the lease", async () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      vi.mocked(store.heartbeat).mockResolvedValueOnce(false);
      const observed: { signal?: AbortSignal } = {};
      const executor = vi.fn(async (input: GoatTaskExecutorInput) => {
        observed.signal = input.signal;
        await new Promise((resolve) => setTimeout(resolve, GOAT_TASK_HEARTBEAT_INTERVAL_MS + 1));
        return {
          result: "Done.",
          harnessSpec,
          debugTrace,
        };
      });

      const promise = runClaimedGoatTask({
        task: task(),
        env: env(),
        store,
        executor,
      });

      await vi.advanceTimersByTimeAsync(GOAT_TASK_HEARTBEAT_INTERVAL_MS);
      expect(observed.signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBeUndefined();

      expect(store.complete).not.toHaveBeenCalled();
      expect(store.fail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a claimed task failed when execution throws", async () => {
    const store = createStore();
    const executor = vi.fn(async () => {
      throw Object.assign(new Error("sandbox failed"), { debugTrace });
    });

    await expect(
      runClaimedGoatTask({
        task: task(),
        env: env(),
        store,
        executor,
      }),
    ).rejects.toThrow("sandbox failed");

    expect(store.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_task_1",
        error: "sandbox failed",
        debugTrace,
      }),
    );
    expect(telemetry.recordGoatTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        attributes: expect.objectContaining({
          "goat.task_id": "goat_task_1",
          "goat.status": "failed",
          "goat.failure_category": "unknown",
        }),
      }),
    );
    expect(store.complete).not.toHaveBeenCalled();
  });
});

function createStore(): GoatTaskStore {
  return {
    claimNext: vi.fn(async () => null),
    heartbeat: vi.fn(async () => true),
    updateStage: vi.fn(async () => true),
    updateCodexEngineSessionId: vi.fn(async () => true),
    ensureUserMessage: vi.fn(async () => "goat_task_msg_user"),
    listConversationMessages: vi.fn(async () => [
      { role: "user" as const, content: "Research Marseille" },
    ]),
    createMessage: vi.fn(async () => true),
    updateMessageContent: vi.fn(async () => true),
    completeMessage: vi.fn(async () => true),
    failMessage: vi.fn(async () => true),
    appendEvent: vi.fn(async () => true),
    recordModelUsage: vi.fn(async () => true),
    recordToolUsage: vi.fn(async () => true),
    recordSandboxUsage: vi.fn(async () => true),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
  };
}

function task(overrides: Partial<GoatTask> = {}): GoatTask {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    userWorkosId: "user_1",
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    sessionId: null,
    scheduleId: null,
    scheduledFor: null,
    workflowId: null,
    workflowBrainRef: null,
    status: "running",
    stage: "planning",
    result: null,
    error: null,
    reportedOutcome: null,
    outcomeComment: null,
    harnessSpec,
    debugTrace: {},
    codexEngineSessionId: null,
    sandboxId: null,
    attempts: 1,
    nextRunAt: now,
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: undefined,
    publicUrl: undefined,
    llmBrokerEnabled: true,
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa",
    goatBrowserEnabled: false,
    agentBrowserProvider: undefined,
    browserlessApiKey: undefined,
    browserlessApiUrl: undefined,
    browserlessTtl: undefined,
    browserlessStealth: undefined,
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
    goatCodexChatIdleTimeoutMs: 1_800_000,
    toolArgRepairEnabled: false,
    jobLeaseTtlMs: 300_000,
    jobMaxLeaseBusyAttempts: 10,
    goatTaskWorkerEnabled: false,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
