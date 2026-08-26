import type { ClaimedWikiIngestJob } from "@opencompany/db/wiki-ingest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type WikiAgentIngestResult,
  WikiAgentOutcomeError,
  WikiIngestBudgetError,
} from "./wiki-agent-ingest";
import {
  retryMaxAttempts,
  runClaimedWikiIngestJob,
  WIKI_INGEST_BUDGET_MAX_ATTEMPTS,
  WIKI_INGEST_OUTCOME_MAX_ATTEMPTS,
  type WikiIngestStore,
} from "./wiki-ingest-worker";

const credits = vi.hoisted(() => ({
  recordCreditDebit: vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true as const,
    ledgerId: 456,
  })),
}));

const telemetry = vi.hoisted(() => ({
  recordModelCost: vi.fn(),
  startSpan: vi.fn(() => ({
    setAttributes: vi.fn(),
    runInContext: vi.fn((run: () => unknown) => run()),
    fail: vi.fn(() => "unknown"),
    end: vi.fn(),
  })),
  withSpan: vi.fn(async (_name: string, _attributes: unknown, run: () => Promise<unknown>) =>
    run(),
  ),
}));

vi.mock("@opencompany/db/credits", () => ({
  recordCreditDebit: credits.recordCreditDebit,
}));

vi.mock("@opencompany/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opencompany/telemetry")>()),
  recordModelCost: telemetry.recordModelCost,
  startSpan: telemetry.startSpan,
  withSpan: telemetry.withSpan,
}));

vi.mock("@opencompany/observability/braintrust", () => ({
  flushBraintrust: vi.fn(async () => undefined),
  traceBraintrust: vi.fn(
    async (_input: unknown, run: (span: { rootSpanId: string }) => Promise<unknown>) =>
      run({ rootSpanId: "braintrust-root-123" }),
  ),
}));

vi.mock("@opencompany/telemetry/latitude", () => ({
  flushLatitude: vi.fn(async () => undefined),
}));

const now = new Date("2026-08-24T12:00:00.000Z");

function job(overrides: Partial<ClaimedWikiIngestJob> = {}): ClaimedWikiIngestJob {
  return {
    id: "gwjob_123",
    workspaceId: "workspace_123",
    sourceItemId: "gwsrc_123",
    sourceProvider: "jamie",
    sourceConnectionId: "connection_123",
    integrationId: "integration_123",
    contentHash: "hash_123",
    status: "running",
    attempts: 1,
    nextRetryAt: now,
    leaseId: "lease_123",
    leaseOwner: "runner_123",
    leaseExpiresAt: new Date(now.getTime() + 300_000),
    heartbeatAt: now,
    lastError: null,
    skipReason: null,
    traceRef: null,
    result: {},
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    sourceType: "meeting",
    sourceRef: "jamie:meeting:meeting_123",
    title: "Roadmap review",
    occurredAt: now,
    rawPayload: { raw: true },
    normalizedPayload: {
      sourceProvider: "jamie",
      sourceType: "meeting",
      contentHash: "hash_123",
    },
    rawEventCount: 1,
    ...overrides,
  };
}

function result(overrides: Partial<WikiAgentIngestResult> = {}): WikiAgentIngestResult {
  const usage = {
    inputTokens: 1_000,
    outputTokens: 100,
    totalTokens: 1_100,
    cacheReadInputTokens: 200,
    cacheWriteInputTokens: 100,
  };
  const budget = {
    limitUsdMicros: 1_000_000,
    stopThresholdUsdMicros: 900_000,
    modelCostUsdMicros: 2_000,
    totalCostUsdMicros: 2_000,
    accountingComplete: true,
    exhausted: false,
  };
  return {
    model: "anthropic/claude-haiku-4.5",
    skipped: false,
    steps: 2,
    toolCalls: 2,
    mutations: 1,
    pages: [{ path: "projects/roadmap", title: "Roadmap", action: "updated" }],
    usage,
    budget,
    summary: "Updated the roadmap page.",
    trace: {
      schemaVersion: "goat.wiki_ingest_trace.v1",
      model: "anthropic/claude-haiku-4.5",
      steps: 2,
      toolCallCount: 2,
      mutations: 1,
      usage,
      finalText: "Updated the roadmap page.",
      toolCalls: [],
      truncatedToolCalls: 0,
      budget,
      createdAt: now.toISOString(),
    },
    ...overrides,
  };
}

function store(overrides: Partial<WikiIngestStore> = {}): WikiIngestStore {
  return {
    claimNext: vi.fn(async () => null),
    heartbeat: vi.fn(async () => true),
    release: vi.fn(async () => true),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    skip: vi.fn(async () => true),
    resolveSource: vi.fn(async () => ({ actorUserWorkosId: "owner_123", config: {} })),
    ...overrides,
  };
}

const env = {
  apiOrigin: "http://api.local",
  apiInternalToken: "internal-token",
  vercelAiGatewayApiKey: "gateway-key",
};

describe("opencompany wiki ingest worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completes a successful run, attributes it to the source owner, and debits the attempt", async () => {
    const ingestStore = store();
    const agentRun = vi.fn(async () => result());

    await runClaimedWikiIngestJob({ job: job(), env, store: ingestStore, agentRun });

    expect(agentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserWorkosId: "owner_123",
        workspaceId: "workspace_123",
        sourceProvider: "jamie",
        sourceConfig: {},
      }),
    );
    expect(ingestStore.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        traceRef: "braintrust-root-123",
        result: expect.objectContaining({ mutations: 1, durationMs: expect.any(Number) }),
      }),
    );
    const debitInput = credits.recordCreditDebit.mock.calls[0]?.[0];
    expect(debitInput).toMatchObject({
      workspaceId: "workspace_123",
      userWorkosId: "owner_123",
      idempotencyKey: "wiki_ingest_model:gwjob_123:1",
      metadata: { wikiIngestJobId: "gwjob_123" },
      providerCostUsdMicros: 2_000,
    });
    expect(debitInput).not.toHaveProperty("ingestJobId");
  });

  it("records wiki triage separately and includes it in the debit cost basis", async () => {
    const ingestStore = store();
    const triage = {
      model: "openai/gpt-5.4-nano",
      decision: "ingest" as const,
      reason: "The comment records a durable project decision.",
      entityHints: ["opencompany"],
      usage: {
        inputTokens: 300,
        outputTokens: 30,
        totalTokens: 330,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      modelCostUsdMicros: 500,
    };
    const agentResult = result();
    agentResult.budget.modelCostUsdMicros = 2_500;
    agentResult.budget.totalCostUsdMicros = 2_500;
    agentResult.trace.budget = agentResult.budget;
    agentResult.trace.triage = triage;

    await runClaimedWikiIngestJob({
      job: job({ sourceProvider: "github", sourceType: "activity" }),
      env,
      store: ingestStore,
      agentRun: vi.fn(async () => agentResult),
    });

    expect(telemetry.recordModelCost).toHaveBeenCalledTimes(2);
    expect(telemetry.recordModelCost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({ "goat.model": triage.model }),
      }),
    );
    expect(credits.recordCreditDebit.mock.calls[0]?.[0]).toMatchObject({
      providerCostUsdMicros: 2_500,
      costBasis: {
        modelCostUsdMicros: 2_500,
        triage: {
          model: triage.model,
          decision: "ingest",
          modelCostUsdMicros: 500,
          usage: triage.usage,
        },
      },
    });
  });

  it("persists explicit, inferred, and triage skip outcomes", async () => {
    for (const skipMode of ["explicit", "inferred_no_mutations", "triage"] as const) {
      const ingestStore = store();
      const reason =
        skipMode === "explicit"
          ? "already known"
          : skipMode === "triage"
            ? "obvious inbox noise"
            : "nothing durable";
      await runClaimedWikiIngestJob({
        job: job(),
        env,
        store: ingestStore,
        agentRun: vi.fn(async () =>
          result({
            skipped: true,
            reason,
            skipMode,
            mutations: 0,
          }),
        ),
      });
      expect(ingestStore.skip).toHaveBeenCalledWith(
        expect.objectContaining({
          reason,
        }),
      );
      expect(ingestStore.complete).not.toHaveBeenCalled();
    }
  });

  it("selects one budget attempt, two outcome attempts, and five infrastructure attempts", () => {
    const budgetResult = result();
    const budgetError = new WikiIngestBudgetError("budget", {
      budget: budgetResult.budget,
      trace: budgetResult.trace,
      usage: budgetResult.usage,
      steps: budgetResult.steps,
      toolCalls: budgetResult.toolCalls,
      mutations: budgetResult.mutations,
      pages: budgetResult.pages,
    });
    expect(retryMaxAttempts(budgetError)).toBe(WIKI_INGEST_BUDGET_MAX_ATTEMPTS);
    expect(retryMaxAttempts(new WikiAgentOutcomeError("outcome"))).toBe(
      WIKI_INGEST_OUTCOME_MAX_ATTEMPTS,
    );
    expect(retryMaxAttempts(new Error("network"))).toBe(5);
  });

  it.each([
    [new WikiAgentOutcomeError("no accepted write"), 2],
    [new Error("gateway unavailable"), 5],
  ])("passes the selected retry tier to job failure", async (error, maxAttempts) => {
    const ingestStore = store();

    await expect(
      runClaimedWikiIngestJob({
        job: job(),
        env,
        store: ingestStore,
        agentRun: vi.fn(async () => {
          throw error;
        }),
      }),
    ).rejects.toBe(error);
    expect(ingestStore.fail).toHaveBeenCalledWith(
      expect.objectContaining({ maxAttempts, attempts: 1 }),
    );
  });

  it("persists budget trace data and terminates at one attempt", async () => {
    const ingestStore = store();
    const failureResult = result();
    const error = new WikiIngestBudgetError("budget reached", {
      budget: failureResult.budget,
      trace: failureResult.trace,
      usage: failureResult.usage,
      steps: failureResult.steps,
      toolCalls: failureResult.toolCalls,
      mutations: 0,
      pages: [],
    });

    await expect(
      runClaimedWikiIngestJob({
        job: job(),
        env,
        store: ingestStore,
        agentRun: vi.fn(async () => {
          throw error;
        }),
      }),
    ).rejects.toBe(error);
    expect(ingestStore.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAttempts: 1,
        result: expect.objectContaining({ trace: failureResult.trace }),
      }),
    );
  });

  it("aborts the agent and does not transition the job after heartbeat lease loss", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const ingestStore = store({ heartbeat });
    let observedSignal: AbortSignal | undefined;
    const agentRun = vi.fn(
      (
        agentInput: Parameters<
          NonNullable<Parameters<typeof runClaimedWikiIngestJob>[0]["agentRun"]>
        >[0],
      ) =>
        new Promise<WikiAgentIngestResult>((_resolve, reject) => {
          observedSignal = agentInput.signal;
          agentInput.signal?.addEventListener("abort", () => reject(agentInput.signal?.reason), {
            once: true,
          });
        }),
    );

    try {
      const running = runClaimedWikiIngestJob({
        job: job(),
        env,
        store: ingestStore,
        agentRun,
        heartbeatIntervalMs: 10,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(agentRun).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      await running;

      expect(observedSignal?.aborted).toBe(true);
      expect(ingestStore.complete).not.toHaveBeenCalled();
      expect(ingestStore.skip).not.toHaveBeenCalled();
      expect(ingestStore.fail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start or transition the job when the initial heartbeat fails", async () => {
    const ingestStore = store({
      heartbeat: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const agentRun = vi.fn(async () => result());

    await runClaimedWikiIngestJob({ job: job(), env, store: ingestStore, agentRun });

    expect(agentRun).not.toHaveBeenCalled();
    expect(ingestStore.complete).not.toHaveBeenCalled();
    expect(ingestStore.skip).not.toHaveBeenCalled();
    expect(ingestStore.fail).not.toHaveBeenCalled();
  });

  it("requeues an active job when shutdown handoff aborts it", async () => {
    const shutdown = new AbortController();
    const ingestStore = store();
    const agentRun = vi.fn(
      (
        agentInput: Parameters<
          NonNullable<Parameters<typeof runClaimedWikiIngestJob>[0]["agentRun"]>
        >[0],
      ) =>
        new Promise<WikiAgentIngestResult>((_resolve, reject) => {
          agentInput.signal?.addEventListener("abort", () => reject(agentInput.signal?.reason), {
            once: true,
          });
        }),
    );
    const running = runClaimedWikiIngestJob({
      job: job(),
      env,
      store: ingestStore,
      agentRun,
      signal: shutdown.signal,
    });
    await vi.waitFor(() => expect(agentRun).toHaveBeenCalledOnce());

    shutdown.abort(new Error("drain deadline"));
    await running;

    expect(ingestStore.release).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gwjob_123", leaseId: "lease_123" }),
    );
    expect(ingestStore.fail).not.toHaveBeenCalled();
  });
});
