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

const harnessSpec: GoatHarnessSpec = {
  prompt: "Research Marseille",
  model: "openai/gpt-5.4-mini",
  tools: ["exa", "goat_result"],
  resultMode: "freeform",
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
      await input.reportStage("running", { harnessSpec, sandboxId: "sbx_123" });
      return {
        result: "Done.",
        harnessSpec,
        debugTrace,
        sandboxId: "sbx_123",
      };
    });

    await runClaimedGoatTask({
      task: task(),
      env: env(),
      store,
      executor,
    });

    expect(store.updateStage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_task_1",
        stage: "running",
        sandboxId: "sbx_123",
      }),
    );
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "goat_task_1",
        result: "Done.",
        debugTrace,
        sandboxId: "sbx_123",
      }),
    );
    expect(store.fail).not.toHaveBeenCalled();
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
          sandboxId: "sbx_123",
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
    expect(store.complete).not.toHaveBeenCalled();
  });
});

function createStore(): GoatTaskStore {
  return {
    claimNext: vi.fn(async () => null),
    heartbeat: vi.fn(async () => true),
    updateStage: vi.fn(async () => true),
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
    status: "running",
    stage: "planning",
    result: null,
    error: null,
    harnessSpec,
    debugTrace: {},
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
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
