import { calculateModelUsageCost } from "@opencompany/billing";
import { normalizeJamieMeetingCompletedWebhook } from "@opencompany/goat-brain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOAT_BRAIN_AGENT_SKIP_SENTINEL,
  GoatBrainAgentOutcomeError,
  GoatBrainIngestBudgetError,
} from "./goat-brain-agent-ingest";
import {
  GOAT_BRAIN_INGEST_MAX_ATTEMPTS,
  GOAT_BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS,
  type GoatBrainIngestStore,
  runClaimedGoatBrainIngestJob,
  startGoatBrainIngestWorker,
} from "./goat-brain-ingest-worker";
import { buildJamieMeetingBrainWrites } from "./goat-brain-jamie-writes";

const telemetry = vi.hoisted(() => ({
  recordGoatBrainIngestRun: vi.fn(),
  recordGoatModelCost: vi.fn(),
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

const billing = vi.hoisted(() => ({
  releasePendingGoatIngestionReservations: vi.fn(async () => ({ released: 0, failed: 0 })),
}));

vi.mock("@opencompany/db/goat-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/db/goat-billing")>();
  return {
    ...actual,
    releasePendingGoatIngestionReservations: billing.releasePendingGoatIngestionReservations,
  };
});

vi.mock("@opencompany/goat-observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/goat-observability")>();
  return {
    ...actual,
    recordGoatBrainIngestRun: telemetry.recordGoatBrainIngestRun,
    recordGoatModelCost: telemetry.recordGoatModelCost,
    startGoatSpan: telemetry.startGoatSpan,
    withGoatSpan: telemetry.withGoatSpan,
  };
});

function jamieItem(segmentCount = 2) {
  return normalizeJamieMeetingCompletedWebhook(
    {
      metadata: {
        event: "meeting.completed",
        created: "2026-01-01T11:00:00.000Z",
      },
      data: {
        user: { id: "user_123" },
        event: {
          externalId: "calendar_event_123",
          title: "Roadmap Review",
          startTime: "2026-01-01T10:00:00.000Z",
          summary: "Discussed priorities for the next product cycle.",
          participants: [{ name: "Jamie", email: "jamie@example.com" }],
          actionItems: ["Share the revised roadmap"],
          transcript: Array.from({ length: segmentCount }, (_, index) => ({
            speakerName: index % 2 === 0 ? "Jamie" : "Alex",
            startTime: `00:${String(index).padStart(2, "0")}:00`,
            text: `Transcript segment ${index}`,
          })),
        },
      },
    },
    { capturedAt: "2026-01-01T11:01:00.000Z" },
  );
}

describe("Goat Brain ingest worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("releases paused reservations before polling with the worker's shared store", async () => {
    let resolveRelease: (result: { released: number; failed: number }) => void = () => {};
    billing.releasePendingGoatIngestionReservations.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRelease = resolve;
      }),
    );
    const claimNext = vi.fn(async () => null);
    const store: GoatBrainIngestStore = {
      claimNext,
      heartbeat: vi.fn(async () => true),
      complete: vi.fn(async () => true),
      skip: vi.fn(async () => true),
      fail: vi.fn(async () => true),
    };
    const worker = startGoatBrainIngestWorker(
      {
        instanceId: "runner_test",
        workerConcurrency: 1,
      } as Parameters<typeof startGoatBrainIngestWorker>[0],
      { store, pollIntervalMs: 60_000 },
    );

    try {
      await vi.waitFor(() => {
        expect(billing.releasePendingGoatIngestionReservations).toHaveBeenCalledOnce();
      });
      expect(claimNext).not.toHaveBeenCalled();
      resolveRelease({ released: 0, failed: 0 });
      await vi.waitFor(() => expect(claimNext).toHaveBeenCalledOnce());
      expect(billing.releasePendingGoatIngestionReservations).toHaveBeenCalledWith({
        now: expect.any(Date),
        maxWorkspaces: 50,
      });
      expect(
        billing.releasePendingGoatIngestionReservations.mock.invocationCallOrder[0],
      ).toBeLessThan(claimNext.mock.invocationCallOrder[0] as number);
    } finally {
      resolveRelease({ released: 0, failed: 0 });
      await worker.stop();
    }
  });

  it("builds deterministic Jamie meeting and evidence documents", () => {
    const first = buildJamieMeetingBrainWrites(jamieItem());
    const second = buildJamieMeetingBrainWrites(jamieItem());

    expect(second.meetingBrainId).toBe(first.meetingBrainId);
    expect(second.evidenceBrainId).toBe(first.evidenceBrainId);
    expect(first.meetingContent).toContain("kind: page");
    expect(first.meetingContent).toContain("type: meeting");
    expect(first.meetingContent).toContain("folder: meetings");
    expect(first.meetingContent).toContain("[[evidence:");
    expect(first.evidenceContent).toContain("kind: evidence");
    expect(first.evidenceContent).toContain("type: meeting");
    expect(first.evidenceContent).toContain("folder: evidence/document");
    expect(first.evidenceContent).toContain("Transcript segment 0");
    expect(first.truncatedTranscript).toBe(false);
  });

  it("bounds large Jamie transcripts in Brain evidence", () => {
    const item = jamieItem(5000);
    item.content.meeting.transcript = item.content.meeting.transcript.map((segment) => ({
      ...segment,
      text: "large transcript segment ".repeat(200),
    }));

    const writes = buildJamieMeetingBrainWrites(item);

    expect(writes.truncatedTranscript).toBe(true);
    expect(writes.evidenceContent).toContain("Transcript truncated after");
    expect(Buffer.byteLength(writes.evidenceContent, "utf8")).toBeLessThan(1_000_000);
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
    const store: GoatBrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete,
      skip,
      fail,
    };

    await runClaimedGoatBrainIngestJob({
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

    expect(run).toHaveBeenCalledWith({
      jobId: "gbjob_123",
      userWorkosId: "user_123",
      brainRef: "gbrain_123",
      integrationId: "gint_123",
      item: normalizedPayload,
      env: { vercelAiGatewayApiKey: "gw_test", blobReadWriteToken: undefined },
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ result: { handled: true } }));
    expect(telemetry.recordGoatBrainIngestRun).toHaveBeenCalledWith(
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
    expect(telemetry.recordGoatModelCost).not.toHaveBeenCalled();
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
    const store: GoatBrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete: vi.fn(async () => true),
      skip: vi.fn(async () => true),
      fail: vi.fn(async () => true),
    };

    await runClaimedGoatBrainIngestJob({
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
    expect(telemetry.recordGoatModelCost).toHaveBeenCalledOnce();
    expect(telemetry.recordGoatModelCost).toHaveBeenCalledWith({
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
          summary: GOAT_BRAIN_AGENT_SKIP_SENTINEL,
        },
        reason: "routine_linear_status_change",
      },
      {
        result: { skipped: true, summary: "No durable brain material." },
        reason: "No durable brain material.",
      },
      {
        result: { skipped: true, summary: GOAT_BRAIN_AGENT_SKIP_SENTINEL },
        reason: null,
      },
    ]) {
      const complete = vi.fn(async () => true);
      const skip = vi.fn(async () => true);
      const fail = vi.fn(async () => true);
      const store: GoatBrainIngestStore = {
        claimNext: vi.fn(async () => null),
        heartbeat: vi.fn(async () => true),
        complete,
        skip,
        fail,
      };

      await runClaimedGoatBrainIngestJob({
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

      expect(skip).toHaveBeenCalledWith(expect.objectContaining({ result, reason }));
      expect(telemetry.recordGoatBrainIngestRun).toHaveBeenCalledWith(
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
    const store: GoatBrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete,
      skip,
      fail,
    };

    await expect(
      runClaimedGoatBrainIngestJob({
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
        maxAttempts: GOAT_BRAIN_INGEST_MAX_ATTEMPTS,
      }),
    );
    expect(telemetry.recordGoatBrainIngestRun).toHaveBeenCalledWith(
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
      throw new GoatBrainAgentOutcomeError(
        "Goat Brain ingestion agent finished without writing to the brain and did not skip.",
      );
    });
    const fail = vi.fn(async () => true);
    const store: GoatBrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete: vi.fn(async () => true),
      skip: vi.fn(async () => true),
      fail,
    };

    await expect(
      runClaimedGoatBrainIngestJob({
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
          attempts: GOAT_BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS,
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
        attempts: GOAT_BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS,
        maxAttempts: GOAT_BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS,
      }),
    );
    // attempts >= the outcome cap: telemetry records this run as terminal.
    expect(telemetry.recordGoatBrainIngestRun).toHaveBeenCalledWith(
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
      throw new GoatBrainIngestBudgetError("Goat Brain ingestion budget exhausted.", failureResult);
    });
    const fail = vi.fn(async () => true);
    const store: GoatBrainIngestStore = {
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => true),
      complete: vi.fn(async () => true),
      skip: vi.fn(async () => true),
      fail,
    };

    await expect(
      runClaimedGoatBrainIngestJob({
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
      expect.objectContaining({ attempts: 1, maxAttempts: 1, result: failureResult }),
    );
    expect(telemetry.recordGoatBrainIngestRun).toHaveBeenCalledWith(
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
    expect(telemetry.recordGoatModelCost).toHaveBeenCalledOnce();
    expect(telemetry.recordGoatModelCost).toHaveBeenCalledWith({
      costUsdMicros: expectedCost.totalCostUsdMicros,
      attributes: {
        "goat.model": failureResult.trace.model,
        "goat.surface": "brain_ingest",
      },
    });
  });
});
