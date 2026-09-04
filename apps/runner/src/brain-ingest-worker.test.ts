import { calculateModelUsageCost } from "@opencompany/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_AGENT_SKIP_SENTINEL,
  BrainAgentOutcomeError,
  BrainIngestBudgetError,
} from "./brain-agent-ingest";
import {
  BRAIN_INGEST_MAX_ATTEMPTS,
  BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS,
  type BrainIngestJobWithSource,
  type BrainIngestStore,
  runClaimedBrainIngestJob,
  startBrainIngestWorker,
} from "./brain-ingest-worker";

const analytics = vi.hoisted(() => ({
  captureProductModelSpendRecorded: vi.fn(async () => undefined),
  captureProductServerEvent: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductModelSpendRecorded: analytics.captureProductModelSpendRecorded,
  captureProductServerEvent: analytics.captureProductServerEvent,
}));

const telemetry = vi.hoisted(() => ({
  recordBrainIngestRun: vi.fn(),
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

const billing = vi.hoisted(() => ({
  releasePendingIngestionReservations: vi.fn(async () => ({ released: 0, failed: 0 })),
}));

const credits = vi.hoisted(() => ({
  recordCreditDebit: vi.fn(async () => ({ ok: true as const, ledgerId: 456 })),
}));

vi.mock("@opencompany/db/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/db/billing")>();
  return {
    ...actual,
    releasePendingIngestionReservations: billing.releasePendingIngestionReservations,
  };
});

vi.mock("@opencompany/db/credits", () => ({
  recordCreditDebit: credits.recordCreditDebit,
}));

vi.mock("@opencompany/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/telemetry")>();
  return {
    ...actual,
    recordBrainIngestRun: telemetry.recordBrainIngestRun,
    recordModelCost: telemetry.recordModelCost,
    startSpan: telemetry.startSpan,
    withSpan: telemetry.withSpan,
  };
});

describe("opencompany Brain ingest worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("releases paused reservations before polling with the worker's shared store", async () => {
    let resolveRelease: (result: { released: number; failed: number }) => void = () => {};
    billing.releasePendingIngestionReservations.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRelease = resolve;
      }),
    );
    const claimNext = vi.fn(async () => null);
    const store: BrainIngestStore = {
      claimNext,
      heartbeat: vi.fn(async () => true),
      complete: vi.fn(async () => true),
      skip: vi.fn(async () => true),
      fail: vi.fn(async () => true),
    };
    const worker = startBrainIngestWorker(
      {
        instanceId: "runner_test",
        workerConcurrency: 1,
      } as Parameters<typeof startBrainIngestWorker>[0],
      { store, pollIntervalMs: 60_000 },
    );

    try {
      await vi.waitFor(() => {
        expect(billing.releasePendingIngestionReservations).toHaveBeenCalledOnce();
      });
      expect(claimNext).not.toHaveBeenCalled();
      resolveRelease({ released: 0, failed: 0 });
      await vi.waitFor(() => expect(claimNext).toHaveBeenCalledOnce());
      expect(claimNext).toHaveBeenCalledWith(
        expect.objectContaining({
          supportedJobs: expect.arrayContaining([
            {
              kind: "brain_pointer_hydrate",
              sourceProvider: "gmail",
              sourceType: "pointer",
            },
            {
              kind: "brain_pointer_hydrate",
              sourceProvider: "linear",
              sourceType: "pointer",
            },
          ]),
        }),
      );
      expect(billing.releasePendingIngestionReservations).toHaveBeenCalledWith({
        now: expect.any(Date),
        maxWorkspaces: 50,
      });
      expect(billing.releasePendingIngestionReservations.mock.invocationCallOrder[0]).toBeLessThan(
        claimNext.mock.invocationCallOrder[0] as number,
      );
    } finally {
      resolveRelease({ released: 0, failed: 0 });
      await worker.stop();
    }
  });

  it("dispatches claimed jobs through a registered source handler", async () => {
    const normalizedPayload = {
      sourceProvider: "jamie" as const,
      sourceType: "meeting" as const,
      externalId: "external_123",
      sourceRef: "jamie:meeting:external_123",
      title: "Registry Test",
      occurredAt: "2026-01-01T10:00:00.000Z",
      capturedAt: "2026-01-01T10:01:00.000Z",
      contentHash: "hash_123",
      contentHashInput: {},
      content: {},
    };
    const run = vi.fn(async () => ({ handled: true }));
    const complete = vi.fn(async () => true);
    const skip = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const store: BrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete,
      skip,
      fail,
    };

    await runClaimedBrainIngestJob({
      env: { jobLeaseTtlMs: 30_000, vercelAiGatewayApiKey: "gw_test" },
      store,
      handlers: [
        {
          descriptor: {
            kind: "brain_source_item_ingest",
            sourceProvider: "jamie",
            sourceType: "meeting",
          },
          isPayload: (value): value is typeof normalizedPayload => value === normalizedPayload,
          run,
        },
      ],
      job: {
        id: "gbjob_123",
        sourceItemId: "gbsrc_123",
        userWorkosId: "user_123",
        workspaceId: "goat_ws_user_123",
        sourceProvider: "jamie",
        sourceConnectionId: "gint_123",
        integrationId: "gint_123",
        brainRef: "gbrain_123",
        sourceType: "meeting",
        kind: "brain_source_item_ingest",
        contentHash: "hash_123",
        status: "running",
        attempts: 1,
        nextRunAt: new Date("2026-01-01T10:00:00.000Z"),
        leaseId: "lease_123",
        leaseOwner: "runner_123",
        leaseExpiresAt: new Date("2026-01-01T10:05:00.000Z"),
        lastError: null,
        result: {},
        completedAt: null,
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        updatedAt: new Date("2026-01-01T10:00:00.000Z"),
        normalizedPayload,
      },
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "gbjob_123",
        userWorkosId: "user_123",
        brainRef: "gbrain_123",
        integrationId: "gint_123",
        item: normalizedPayload,
        env: { vercelAiGatewayApiKey: "gw_test", blobReadWriteToken: undefined },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ handled: true, durationMs: expect.any(Number) }),
      }),
    );
    expect(analytics.captureProductServerEvent).toHaveBeenCalledWith(
      "brain_ingestion_completed",
      "user_123",
      {
        workspace_id: "goat_ws_user_123",
        brain_id: "gbrain_123",
        provider: "jamie",
        source_type: "meeting",
      },
      { workspaceId: "goat_ws_user_123" },
    );
    expect(telemetry.recordBrainIngestRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        attributes: expect.objectContaining({
          "goat.brain_ingest_job_id": "gbjob_123",
          "goat.brain_source_item_id": "gbsrc_123",
          "goat.status": "succeeded",
          "goat.ingest_kind": "brain_source_item_ingest",
          "goat.source_provider": "jamie",
          "goat.source_type": "meeting",
        }),
      }),
    );
    expect(skip).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(telemetry.recordModelCost).not.toHaveBeenCalled();
  });

  it("aborts in-flight handlers when their source revokes the job lease", async () => {
    vi.useFakeTimers();
    try {
      const normalizedPayload = {
        sourceProvider: "attio" as const,
        sourceType: "activity" as const,
        externalId: "window_123",
        sourceRef: "attio:workspace_1:person:record_1",
        title: "Ada Lovelace",
        occurredAt: "2026-07-17T10:00:00.000Z",
        capturedAt: "2026-07-17T10:01:00.000Z",
        contentHash: "hash_123",
        contentHashInput: {},
        content: {},
      };
      let markStarted = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const run = vi.fn(
        async (input: { signal?: AbortSignal }): Promise<Record<string, unknown>> => {
          markStarted();
          return await new Promise<Record<string, unknown>>((_resolve, reject) => {
            input.signal?.addEventListener(
              "abort",
              () => reject(input.signal?.reason ?? new Error("aborted")),
              { once: true },
            );
          });
        },
      );
      const heartbeat = vi
        .fn<BrainIngestStore["heartbeat"]>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const complete = vi.fn(async () => true);
      const fail = vi.fn(async () => true);
      const store: BrainIngestStore = {
        claimNext: vi.fn(async () => null),
        heartbeat,
        complete,
        skip: vi.fn(async () => true),
        fail,
      };

      const processing = runClaimedBrainIngestJob({
        env: { jobLeaseTtlMs: 30_000, vercelAiGatewayApiKey: "gw_test" },
        store,
        handlers: [
          {
            descriptor: {
              kind: "brain_agent_ingest",
              sourceProvider: "attio",
              sourceType: "activity",
            },
            isPayload: (value): value is typeof normalizedPayload => value === normalizedPayload,
            run,
          },
        ],
        job: {
          id: "gbjob_attio_1",
          sourceItemId: "gbsrc_attio_1",
          userWorkosId: "user_123",
          sourceProvider: "attio",
          sourceConnectionId: "gint_attio_1",
          integrationId: "gint_attio_1",
          brainRef: "gbrain_123",
          sourceType: "activity",
          kind: "brain_agent_ingest",
          contentHash: "hash_123",
          status: "running",
          attempts: 1,
          nextRunAt: new Date("2026-07-17T10:00:00.000Z"),
          leaseId: "lease_123",
          leaseOwner: "runner_123",
          leaseExpiresAt: new Date("2026-07-17T10:05:00.000Z"),
          lastError: null,
          result: {},
          completedAt: null,
          createdAt: new Date("2026-07-17T10:00:00.000Z"),
          updatedAt: new Date("2026-07-17T10:00:00.000Z"),
          normalizedPayload,
        },
      });

      await started;
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(processing).resolves.toBeUndefined();

      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      expect(telemetry.recordBrainIngestRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "aborted",
          attributes: expect.objectContaining({ "goat.failure_category": "lease_lost" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an in-flight job for immediate retry when runner shutdown aborts it", async () => {
    const shutdown = new AbortController();
    const normalizedPayload = {
      sourceProvider: "attio" as const,
      sourceType: "activity" as const,
      externalId: "window_shutdown",
      sourceRef: "attio:workspace_1:person:record_shutdown",
      title: "Shutdown handoff",
      occurredAt: "2026-08-19T10:00:00.000Z",
      capturedAt: "2026-08-19T10:01:00.000Z",
      contentHash: "hash_shutdown",
      contentHashInput: {},
      content: {},
    };
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishRun = (_result: Record<string, unknown>) => {};
    const run = vi.fn(
      async (_input: { signal?: AbortSignal }): Promise<Record<string, unknown>> => {
        markStarted();
        return await new Promise<Record<string, unknown>>((resolve) => {
          finishRun = resolve;
        });
      },
    );
    const release = vi.fn(async () => true);
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const store: BrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      release,
      complete,
      skip: vi.fn(async () => true),
      fail,
    };
    const job: BrainIngestJobWithSource = {
      id: "gbjob_shutdown",
      sourceItemId: "gbsrc_shutdown",
      userWorkosId: "user_123",
      workspaceId: "workspace_shutdown",
      sourceProvider: "attio",
      sourceConnectionId: "gint_shutdown",
      integrationId: "gint_shutdown",
      brainRef: "gbrain_123",
      sourceType: "activity",
      kind: "brain_agent_ingest",
      contentHash: "hash_shutdown",
      status: "running",
      attempts: 1,
      nextRunAt: new Date("2026-08-19T10:00:00.000Z"),
      leaseId: "lease_shutdown",
      leaseOwner: "runner_shutdown",
      leaseExpiresAt: new Date("2026-08-19T10:05:00.000Z"),
      lastError: null,
      result: {},
      completedAt: null,
      createdAt: new Date("2026-08-19T10:00:00.000Z"),
      updatedAt: new Date("2026-08-19T10:00:00.000Z"),
      normalizedPayload,
    };

    const processing = runClaimedBrainIngestJob({
      env: { jobLeaseTtlMs: 30_000, vercelAiGatewayApiKey: "gw_test" },
      store,
      signal: shutdown.signal,
      handlers: [
        {
          descriptor: {
            kind: "brain_agent_ingest",
            sourceProvider: "attio",
            sourceType: "activity",
          },
          isPayload: (value): value is typeof normalizedPayload => value === normalizedPayload,
          run,
        },
      ],
      job,
    });

    await started;
    shutdown.abort(new Error("runner shutdown"));
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    finishRun({ handled: true });
    await expect(processing).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledWith({
      id: job.id,
      sourceItemId: job.sourceItemId,
      leaseId: "lease_shutdown",
      leaseOwner: "runner_shutdown",
      now: expect.any(Date),
    });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(telemetry.recordBrainIngestRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "aborted",
        attributes: expect.objectContaining({ "goat.failure_category": "runner_shutdown" }),
      }),
    );
  });

  it("records agent ingestion model cost with the brain_ingest surface", async () => {
    const normalizedPayload = {
      sourceProvider: "linear" as const,
      sourceType: "issue" as const,
      externalId: "external_123",
      sourceRef: "linear:issue:G-51",
      title: "Registry Test",
      occurredAt: "2026-01-01T10:00:00.000Z",
      capturedAt: "2026-01-01T10:01:00.000Z",
      contentHash: "hash_123",
      contentHashInput: {},
      content: {},
    };
    const usage = {
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
      cacheReadInputTokens: 200,
      cacheWriteInputTokens: 100,
    };
    const result = {
      handled: true,
      trace: {
        schemaVersion: "goat.brain_ingest_trace.v1",
        model: "anthropic/claude-sonnet-5",
        steps: 1,
        toolCallCount: 0,
        mutations: 1,
        usage,
        finalText: "Updated the brain.",
        toolCalls: [],
        truncatedToolCalls: 0,
        createdAt: "2026-01-01T10:01:00.000Z",
      },
    };
    const store: BrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete: vi.fn(async () => true),
      skip: vi.fn(async () => true),
      fail: vi.fn(async () => true),
    };

    await runClaimedBrainIngestJob({
      env: { jobLeaseTtlMs: 30_000, vercelAiGatewayApiKey: "gw_test" },
      store,
      handlers: [
        {
          descriptor: {
            kind: "brain_agent_ingest",
            sourceProvider: "linear",
            sourceType: "issue",
          },
          isPayload: (value): value is typeof normalizedPayload => value === normalizedPayload,
          run: vi.fn(async () => result),
        },
      ],
      job: {
        id: "gbjob_123",
        sourceItemId: "gbsrc_123",
        userWorkosId: "user_123",
        sourceProvider: "linear",
        sourceConnectionId: "gint_123",
        integrationId: "gint_123",
        brainRef: "gbrain_123",
        sourceType: "issue",
        kind: "brain_agent_ingest",
        contentHash: "hash_123",
        status: "running",
        attempts: 1,
        nextRunAt: new Date("2026-01-01T10:00:00.000Z"),
        leaseId: "lease_123",
        leaseOwner: "runner_123",
        leaseExpiresAt: new Date("2026-01-01T10:05:00.000Z"),
        lastError: null,
        result: {},
        completedAt: null,
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
        updatedAt: new Date("2026-01-01T10:00:00.000Z"),
        normalizedPayload,
      },
    });

    const expectedCost = calculateModelUsageCost({
      modelName: "anthropic/claude-sonnet-5",
      inputTokens: usage.inputTokens,
      inputNoCacheTokens:
        usage.inputTokens - usage.cacheReadInputTokens - usage.cacheWriteInputTokens,
      inputCacheReadTokens: usage.cacheReadInputTokens,
      inputCacheWriteTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
    });
    expect(telemetry.recordModelCost).toHaveBeenCalledOnce();
    expect(telemetry.recordModelCost).toHaveBeenCalledWith({
      costUsdMicros: expectedCost.totalCostUsdMicros,
      attributes: {
        "goat.model": "anthropic/claude-sonnet-5",
        "goat.surface": "brain_ingest",
      },
    });
  });

  it("marks skipped handler results as terminal skips", async () => {
    const normalizedPayload = {
      sourceProvider: "linear" as const,
      sourceType: "issue" as const,
      externalId: "external_123",
      sourceRef: "linear:issue:G-51",
      title: "G-51 add github as source",
      occurredAt: "2026-01-01T10:00:00.000Z",
      capturedAt: "2026-01-01T10:01:00.000Z",
      contentHash: "hash_123",
      contentHashInput: {},
      content: {},
    };
    for (const { result, reason } of [
      {
        result: {
          skipped: true,
          reason: "routine_linear_status_change",
          summary: BRAIN_AGENT_SKIP_SENTINEL,
        },
        reason: "routine_linear_status_change",
      },
      {
        result: { skipped: true, summary: "No durable brain material." },
        reason: "No durable brain material.",
      },
      {
        result: { skipped: true, summary: BRAIN_AGENT_SKIP_SENTINEL },
        reason: null,
      },
    ]) {
      const complete = vi.fn(async () => true);
      const skip = vi.fn(async () => true);
      const fail = vi.fn(async () => true);
      const store: BrainIngestStore = {
        claimNext: vi.fn(async () => null),
        heartbeat: vi.fn(async () => true),
        complete,
        skip,
        fail,
      };

      await runClaimedBrainIngestJob({
        env: { jobLeaseTtlMs: 30_000, vercelAiGatewayApiKey: "gw_test" },
        store,
        handlers: [
          {
            descriptor: {
              kind: "brain_agent_ingest",
              sourceProvider: "linear",
              sourceType: "issue",
            },
            isPayload: (value): value is typeof normalizedPayload => value === normalizedPayload,
            run: vi.fn(async () => result),
          },
        ],
        job: {
          id: "gbjob_123",
          sourceItemId: "gbsrc_123",
          userWorkosId: "user_123",
          sourceProvider: "linear",
          sourceConnectionId: "gint_123",
          integrationId: "gint_123",
          brainRef: "gbrain_123",
          sourceType: "issue",
          kind: "brain_agent_ingest",
          contentHash: "hash_123",
          status: "running",
          attempts: 1,
          nextRunAt: new Date("2026-01-01T10:00:00.000Z"),
          leaseId: "lease_123",
          leaseOwner: "runner_123",
          leaseExpiresAt: new Date("2026-01-01T10:05:00.000Z"),
          lastError: null,
          result: {},
          completedAt: null,
          createdAt: new Date("2026-01-01T10:00:00.000Z"),
          updatedAt: new Date("2026-01-01T10:00:00.000Z"),
          normalizedPayload,
        },
      });

      expect(skip).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({ ...result, durationMs: expect.any(Number) }),
          reason,
        }),
      );
      expect(telemetry.recordBrainIngestRun).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "skipped",
          attributes: expect.objectContaining({
            "goat.brain_ingest_job_id": "gbjob_123",
            "goat.brain_source_item_id": "gbsrc_123",
            "goat.status": "skipped",
          }),
        }),
      );
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    }
    expect(analytics.captureProductServerEvent).not.toHaveBeenCalled();
  });

  it("records failed brain ingest attempts with investigation ids", async () => {
    const normalizedPayload = {
      sourceProvider: "jamie" as const,
      sourceType: "meeting" as const,
      externalId: "external_123",
      sourceRef: "jamie:meeting:external_123",
      title: "Registry Test",
      occurredAt: "2026-01-01T10:00:00.000Z",
      capturedAt: "2026-01-01T10:01:00.000Z",
      contentHash: "hash_123",
      contentHashInput: {},
      content: {},
    };
    const run = vi.fn(async () => {
      throw new Error("gateway stream failed");
    });
    const complete = vi.fn(async () => true);
    const skip = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const store: BrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete,
      skip,
      fail,
    };

    await expect(
      runClaimedBrainIngestJob({
        env: { jobLeaseTtlMs: 30_000, vercelAiGatewayApiKey: "gw_test" },
        store,
        handlers: [
          {
            descriptor: {
              kind: "brain_agent_ingest",
              sourceProvider: "jamie",
              sourceType: "meeting",
            },
            isPayload: (value): value is typeof normalizedPayload => value === normalizedPayload,
            run,
          },
        ],
        job: {
          id: "gbjob_123",
          sourceItemId: "gbsrc_123",
          userWorkosId: "user_123",
          sourceProvider: "jamie",
          sourceConnectionId: "gint_123",
          integrationId: "gint_123",
          brainRef: "gbrain_123",
          sourceType: "meeting",
          kind: "brain_agent_ingest",
          contentHash: "hash_123",
          status: "running",
          attempts: 5,
          nextRunAt: new Date("2026-01-01T10:00:00.000Z"),
          leaseId: "lease_123",
          leaseOwner: "runner_123",
          leaseExpiresAt: new Date("2026-01-01T10:05:00.000Z"),
          lastError: null,
          result: {},
          completedAt: null,
          createdAt: new Date("2026-01-01T10:00:00.000Z"),
          updatedAt: new Date("2026-01-01T10:00:00.000Z"),
          normalizedPayload,
        },
      }),
    ).rejects.toThrow("gateway stream failed");

    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gbjob_123",
        sourceItemId: "gbsrc_123",
        attempts: 5,
        error: "gateway stream failed",
        maxAttempts: BRAIN_INGEST_MAX_ATTEMPTS,
      }),
    );
    expect(telemetry.recordBrainIngestRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        attributes: expect.objectContaining({
          "goat.brain_ingest_job_id": "gbjob_123",
          "goat.brain_source_item_id": "gbsrc_123",
          "goat.status": "failed",
          "goat.failure_category": "unknown",
        }),
      }),
    );
    expect(complete).not.toHaveBeenCalled();
    expect(skip).not.toHaveBeenCalled();
  });

  it("caps retries for deterministic agent-outcome failures", async () => {
    const normalizedPayload = {
      sourceProvider: "jamie" as const,
      sourceType: "meeting" as const,
      externalId: "external_123",
      sourceRef: "jamie:meeting:external_123",
      title: "Registry Test",
      occurredAt: "2026-01-01T10:00:00.000Z",
      capturedAt: "2026-01-01T10:01:00.000Z",
      contentHash: "hash_123",
      contentHashInput: {},
      content: {},
    };
    const run = vi.fn(async () => {
      throw new BrainAgentOutcomeError(
        "opencompany Brain ingestion agent finished without writing to the brain and did not skip.",
      );
    });
    const fail = vi.fn(async () => true);
    const store: BrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete: vi.fn(async () => true),
      skip: vi.fn(async () => true),
      fail,
    };

    await expect(
      runClaimedBrainIngestJob({
        env: { jobLeaseTtlMs: 30_000, vercelAiGatewayApiKey: "gw_test" },
        store,
        handlers: [
          {
            descriptor: {
              kind: "brain_agent_ingest",
              sourceProvider: "jamie",
              sourceType: "meeting",
            },
            isPayload: (value): value is typeof normalizedPayload => value === normalizedPayload,
            run,
          },
        ],
        job: {
          id: "gbjob_123",
          sourceItemId: "gbsrc_123",
          userWorkosId: "user_123",
          sourceProvider: "jamie",
          sourceConnectionId: "gint_123",
          integrationId: "gint_123",
          brainRef: "gbrain_123",
          sourceType: "meeting",
          kind: "brain_agent_ingest",
          contentHash: "hash_123",
          status: "running",
          attempts: BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS,
          nextRunAt: new Date("2026-01-01T10:00:00.000Z"),
          leaseId: "lease_123",
          leaseOwner: "runner_123",
          leaseExpiresAt: new Date("2026-01-01T10:05:00.000Z"),
          lastError: null,
          result: {},
          completedAt: null,
          createdAt: new Date("2026-01-01T10:00:00.000Z"),
          updatedAt: new Date("2026-01-01T10:00:00.000Z"),
          normalizedPayload,
        },
      }),
    ).rejects.toThrow("finished without writing");

    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS,
        maxAttempts: BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS,
      }),
    );
    // attempts >= the outcome cap: telemetry records this run as terminal.
    expect(telemetry.recordBrainIngestRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        attributes: expect.objectContaining({ "goat.status": "failed" }),
      }),
    );
  });

  it("persists budget failure details and does not retry the ingest", async () => {
    const normalizedPayload = {
      sourceProvider: "jamie" as const,
      sourceType: "meeting" as const,
      externalId: "external_123",
      sourceRef: "jamie:meeting:external_123",
      title: "Budget Test",
      occurredAt: "2026-01-01T10:00:00.000Z",
      capturedAt: "2026-01-01T10:01:00.000Z",
      contentHash: "hash_123",
      contentHashInput: {},
      content: {},
    };
    const budget = {
      limitUsdMicros: 500_000,
      stopThresholdUsdMicros: 400_000,
      modelCostUsdMicros: 450_000,
      brainQueryCostUsdMicros: 500,
      webSearchCostUsdMicros: 1_000,
      totalCostUsdMicros: 451_500,
      accountingComplete: true,
      exhausted: true,
    };
    const usage = { inputTokens: 100, outputTokens: 30_000, totalTokens: 30_100 };
    const failureResult = {
      budget,
      trace: {
        schemaVersion: "goat.brain_ingest_trace.v1" as const,
        model: "anthropic/claude-sonnet-5",
        steps: 1,
        toolCallCount: 0,
        mutations: 0,
        usage,
        finalText: "",
        toolCalls: [],
        truncatedToolCalls: 0,
        budget,
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      usage,
      steps: 1,
      toolCalls: 0,
      mutations: 0,
    };
    const run = vi.fn(async () => {
      throw new BrainIngestBudgetError(
        "opencompany Brain ingestion budget exhausted.",
        failureResult,
      );
    });
    const fail = vi.fn(async () => true);
    const store: BrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete: vi.fn(async () => true),
      skip: vi.fn(async () => true),
      fail,
    };

    await expect(
      runClaimedBrainIngestJob({
        env: { jobLeaseTtlMs: 30_000, vercelAiGatewayApiKey: "gw_test" },
        store,
        handlers: [
          {
            descriptor: {
              kind: "brain_agent_ingest",
              sourceProvider: "jamie",
              sourceType: "meeting",
            },
            isPayload: (value): value is typeof normalizedPayload => value === normalizedPayload,
            run,
          },
        ],
        job: {
          id: "gbjob_budget",
          sourceItemId: "gbsrc_123",
          userWorkosId: "user_123",
          workspaceId: "goat_ws_user_123",
          sourceProvider: "jamie",
          sourceConnectionId: "gint_123",
          integrationId: "gint_123",
          brainRef: "gbrain_123",
          sourceType: "meeting",
          kind: "brain_agent_ingest",
          contentHash: "hash_123",
          status: "running",
          attempts: 1,
          nextRunAt: new Date("2026-01-01T10:00:00.000Z"),
          leaseId: "lease_123",
          leaseOwner: "runner_123",
          leaseExpiresAt: new Date("2026-01-01T10:05:00.000Z"),
          lastError: null,
          result: {},
          completedAt: null,
          createdAt: new Date("2026-01-01T10:00:00.000Z"),
          updatedAt: new Date("2026-01-01T10:00:00.000Z"),
          normalizedPayload,
        },
      }),
    ).rejects.toThrow("budget exhausted");

    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        maxAttempts: 1,
        result: expect.objectContaining({
          ...failureResult,
          durationMs: expect.any(Number),
        }),
      }),
    );
    expect(telemetry.recordBrainIngestRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        attributes: expect.objectContaining({
          "goat.status": "failed",
          "goat.budget_exhausted": true,
          "goat.total_cost_usd_micros": 451_500,
        }),
      }),
    );
    const expectedCost = calculateModelUsageCost({
      modelName: failureResult.trace.model,
      inputTokens: usage.inputTokens,
      inputNoCacheTokens: usage.inputTokens,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: usage.outputTokens,
    });
    expect(telemetry.recordModelCost).toHaveBeenCalledOnce();
    expect(telemetry.recordModelCost).toHaveBeenCalledWith({
      costUsdMicros: expectedCost.totalCostUsdMicros,
      attributes: {
        "goat.model": failureResult.trace.model,
        "goat.surface": "brain_ingest",
      },
    });
    expect(credits.recordCreditDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "goat_ws_user_123",
        source: "ingest_model_usage",
        providerCostUsdMicros: 451_500,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 451_500,
      }),
    );
    expect(analytics.captureProductModelSpendRecorded).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_123",
        workspaceId: "goat_ws_user_123",
        billingSource: "ingest_model_usage",
        surface: "brain_ingest",
        model: failureResult.trace.model,
        providerCostUsdMicros: 451_500,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 451_500,
        modelCostUsdMicros: 450_000,
        ledgerId: 456,
        ingestJobId: "gbjob_budget",
      }),
    );
  });
});
