import { randomUUID } from "node:crypto";
import { calculateModelUsageCost, calculatePlatformFeeUsdMicros } from "@opencompany/billing";
import { recordCreditDebit } from "@opencompany/db/credits";
import {
  type ClaimedWikiIngestJob,
  claimNextWikiIngestJob,
  completeWikiIngestJob,
  failWikiIngestJobWithBackoff,
  heartbeatWikiIngestJob,
  releaseWikiIngestJob,
  skipWikiIngestJob,
  WIKI_INGEST_LEASE_TTL_MS,
  WIKI_INGEST_MAX_ATTEMPTS,
} from "@opencompany/db/wiki-ingest";
import { listEnabledWikiSourcesForIntegration } from "@opencompany/db/wiki-sources";
import { captureException, createLogger } from "@opencompany/observability";
import { flushBraintrust, traceBraintrust } from "@opencompany/observability/braintrust";
import {
  hashUserId,
  recordModelCost,
  SPANS,
  startSpan,
  type TelemetryAttributes,
  withSpan,
} from "@opencompany/telemetry";
import { flushLatitude } from "@opencompany/telemetry/latitude";
import type { RunnerEnv } from "./env";
import { createPollingWorker } from "./polling-worker";
import {
  runWikiAgentIngest,
  WIKI_AGENT_SKIP_SENTINEL,
  type WikiAgentIngestInput,
  type WikiAgentIngestResult,
  WikiAgentOutcomeError,
  WikiIngestBudgetError,
} from "./wiki-agent-ingest";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-wiki-ingest",
});

export const WIKI_INGEST_HEARTBEAT_INTERVAL_MS = 5_000;
export const WIKI_INGEST_OUTCOME_MAX_ATTEMPTS = 2;
export const WIKI_INGEST_BUDGET_MAX_ATTEMPTS = 1;
const WIKI_INGEST_POLL_INTERVAL_MS = 5_000;

export type WikiIngestStore = {
  claimNext(input: {
    leaseId: string;
    leaseOwner: string;
    leaseTtlMs: number;
    now: Date;
  }): Promise<ClaimedWikiIngestJob | null>;
  heartbeat(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    leaseTtlMs: number;
    now: Date;
  }): Promise<boolean>;
  release(input: {
    id: string;
    sourceItemId: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
  }): Promise<boolean>;
  complete(input: {
    id: string;
    sourceItemId: string;
    leaseId: string;
    leaseOwner: string;
    result: Record<string, unknown>;
    traceRef?: string | null;
    now: Date;
  }): Promise<boolean>;
  fail(input: {
    id: string;
    sourceItemId: string;
    leaseId: string;
    leaseOwner: string;
    attempts: number;
    error: string;
    maxAttempts: number;
    result?: Record<string, unknown>;
    traceRef?: string | null;
    now: Date;
  }): Promise<boolean>;
  skip(input: {
    id: string;
    sourceItemId: string;
    leaseId: string;
    leaseOwner: string;
    reason: string | null;
    result: Record<string, unknown>;
    traceRef?: string | null;
    now: Date;
  }): Promise<boolean>;
  resolveSource(input: {
    integrationId: string;
    workspaceId: string;
    sourceProvider: ClaimedWikiIngestJob["sourceProvider"];
  }): Promise<{ actorUserWorkosId: string; config: Record<string, unknown> }>;
};

export function createDbWikiIngestStore(): WikiIngestStore {
  return {
    claimNext: (input) =>
      claimNextWikiIngestJob({
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        leaseTtlMs: input.leaseTtlMs,
        now: input.now,
      }),
    heartbeat: heartbeatWikiIngestJob,
    release: releaseWikiIngestJob,
    complete: completeWikiIngestJob,
    fail: failWikiIngestJobWithBackoff,
    skip: skipWikiIngestJob,
    async resolveSource(input) {
      const sources = await listEnabledWikiSourcesForIntegration(input.integrationId);
      const source = sources.find(
        (candidate) =>
          candidate.workspaceId === input.workspaceId &&
          candidate.provider === input.sourceProvider,
      );
      if (!source) {
        throw new Error(
          `No enabled wiki source owns integration ${input.integrationId} in workspace ${input.workspaceId}.`,
        );
      }
      return { actorUserWorkosId: source.userWorkosId, config: source.config };
    },
  };
}

let registeredWikiIngestWakeup: (() => void) | null = null;

export function setWikiIngestWakeup(wake: (() => void) | null) {
  registeredWikiIngestWakeup = wake;
}

export function wakeWikiIngestWorker() {
  registeredWikiIngestWakeup?.();
}

export async function claimWikiIngestJob(input: {
  leaseOwner: string;
  store?: WikiIngestStore;
  leaseTtlMs?: number;
}) {
  const store = input.store ?? createDbWikiIngestStore();
  return store.claimNext({
    leaseId: `goat_wiki_ingest_${randomUUID()}`,
    leaseOwner: input.leaseOwner,
    leaseTtlMs: input.leaseTtlMs ?? WIKI_INGEST_LEASE_TTL_MS,
    now: new Date(),
  });
}

export async function runClaimedWikiIngestJob(input: {
  job: ClaimedWikiIngestJob;
  env: Pick<RunnerEnv, "apiOrigin" | "apiInternalToken" | "vercelAiGatewayApiKey">;
  store?: WikiIngestStore;
  agentRun?: (input: WikiAgentIngestInput) => Promise<WikiAgentIngestResult>;
  signal?: AbortSignal;
  heartbeatIntervalMs?: number;
  leaseTtlMs?: number;
}) {
  const runStartedAt = performance.now();
  const store = input.store ?? createDbWikiIngestStore();
  const agentRun = input.agentRun ?? runWikiAgentIngest;
  const leaseId = requireJobLease(input.job, "leaseId");
  const leaseOwner = requireJobLease(input.job, "leaseOwner");
  const baseAttributes = {
    "goat.wiki_ingest_job_id": input.job.id,
    "goat.wiki_source_item_id": input.job.sourceItemId,
    "goat.workspace_id": input.job.workspaceId,
    "goat.source_provider": input.job.sourceProvider,
    "goat.source_type": input.job.sourceType,
    "goat.status": input.job.status,
    "goat.attempt": input.job.attempts,
    "goat.lease_owner": leaseOwner,
  } satisfies TelemetryAttributes;
  const runSpan = startSpan(SPANS.wikiIngestRun, baseAttributes);
  const runAbort = new AbortController();
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? WIKI_INGEST_HEARTBEAT_INTERVAL_MS;
  const leaseTtlMs = input.leaseTtlMs ?? WIKI_INGEST_LEASE_TTL_MS;
  let leaseActive = true;
  let shutdownRequested = false;
  let releasePromise: Promise<void> | null = null;
  let telemetryFinished = false;
  let traceRef: string | null = null;
  let actorUserWorkosId: string | null = null;

  const loseLease = (reason: Error) => {
    if (!leaseActive) return;
    leaseActive = false;
    runAbort.abort(reason);
  };
  const finishTelemetry = (
    outcome: "success" | "failure" | "aborted" | "skipped",
    attributes: TelemetryAttributes = {},
    error?: unknown,
  ) => {
    if (telemetryFinished) return;
    telemetryFinished = true;
    const failureCategory =
      outcome === "failure" && error
        ? runSpan.fail(error, attributes)
        : (attributes["goat.failure_category"] as string | undefined);
    const finalAttributes = {
      ...baseAttributes,
      "goat.outcome": outcome,
      ...(failureCategory ? { "goat.failure_category": failureCategory } : {}),
      ...attributes,
    } satisfies TelemetryAttributes;
    runSpan.end(finalAttributes);
    const fields = {
      event: "opencompany.goat_wiki_ingest_run_finished",
      job_id: input.job.id,
      source_item_id: input.job.sourceItemId,
      workspace_id: input.job.workspaceId,
      source_provider: input.job.sourceProvider,
      source_type: input.job.sourceType,
      attempt: input.job.attempts,
      outcome,
      status: finalAttributes["goat.status"],
      duration_ms: Math.max(0, Math.round(performance.now() - runStartedAt)),
      ...(failureCategory ? { failure_category: failureCategory } : {}),
    };
    if (outcome === "success" || outcome === "skipped") {
      logger.info("opencompany wiki ingest job finished", fields);
    } else {
      logger.warn("opencompany wiki ingest job finished", fields);
    }
  };
  const releaseForShutdown = () => {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      if (!leaseActive) return;
      const released = await store.release({
        id: input.job.id,
        sourceItemId: input.job.sourceItemId,
        leaseId,
        leaseOwner,
        now: new Date(),
      });
      leaseActive = false;
      finishTelemetry("aborted", {
        "goat.status": released ? "queued" : "running",
        "goat.failure_category": released ? "runner_shutdown" : "lease_lost",
      });
    })();
    void releasePromise.catch((error) => {
      captureException(error, {
        event: "opencompany.goat_wiki_ingest_shutdown_release_failed",
        job_id: input.job.id,
      });
      logger.error("opencompany wiki ingest shutdown release failed", {
        event: "opencompany.goat_wiki_ingest_shutdown_release_failed",
        job_id: input.job.id,
        error,
      });
    });
    return releasePromise;
  };
  const heartbeat = async () => {
    const active = await store.heartbeat({
      id: input.job.id,
      leaseId,
      leaseOwner,
      leaseTtlMs,
      now: new Date(),
    });
    if (!active) loseLease(new Error("Wiki ingestion lease was revoked."));
  };
  const handleHeartbeatFailure = (error: unknown) => {
    captureException(error, {
      event: "opencompany.goat_wiki_ingest_heartbeat_failed",
      job_id: input.job.id,
    });
    logger.warn("opencompany wiki ingest heartbeat failed", {
      event: "opencompany.goat_wiki_ingest_heartbeat_failed",
      job_id: input.job.id,
      error,
    });
    loseLease(new Error("Wiki ingestion heartbeat failed.", { cause: error }));
  };
  const heartbeatTimer = setInterval(() => {
    if (!leaseActive) return;
    void heartbeat().catch(handleHeartbeatFailure);
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
  const requestShutdownHandoff = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    runAbort.abort(new Error("Wiki ingestion was handed off during runner shutdown."));
    void releaseForShutdown();
  };
  if (input.signal?.aborted) requestShutdownHandoff();
  else input.signal?.addEventListener("abort", requestShutdownHandoff, { once: true });

  try {
    if (shutdownRequested) {
      await releaseForShutdown();
      return;
    }
    await heartbeat().catch(handleHeartbeatFailure);
    if (!leaseActive) {
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      return;
    }
    const resolvedSource = await store.resolveSource({
      integrationId: input.job.integrationId,
      workspaceId: input.job.workspaceId,
      sourceProvider: input.job.sourceProvider,
    });
    const resolvedActorUserWorkosId = resolvedSource.actorUserWorkosId;
    actorUserWorkosId = resolvedActorUserWorkosId;
    const userIdHash = hashUserId(resolvedActorUserWorkosId);
    const result = await runSpan.runInContext(() =>
      traceBraintrust(
        {
          name: SPANS.wikiIngestRun,
          type: "task",
          metadata: {
            job_id: input.job.id,
            source_item_id: input.job.sourceItemId,
            workspace_id: input.job.workspaceId,
            source_provider: input.job.sourceProvider,
            source_type: input.job.sourceType,
            attempt: input.job.attempts,
            ...(userIdHash ? { user_id_hash: userIdHash } : {}),
          },
        },
        (span) => {
          traceRef = span?.rootSpanId ?? null;
          return agentRun({
            jobId: input.job.id,
            attempt: input.job.attempts,
            workspaceId: input.job.workspaceId,
            actorUserWorkosId: resolvedActorUserWorkosId,
            sourceProvider: input.job.sourceProvider,
            sourceType: input.job.sourceType,
            sourceRef: input.job.sourceRef,
            title: input.job.title,
            occurredAt: input.job.occurredAt,
            contentHash: input.job.contentHash,
            normalizedPayload: input.job.normalizedPayload,
            sourceConfig: resolvedSource.config,
            env: input.env,
            signal: runAbort.signal,
          });
        },
      ),
    );
    const resultWithDuration = withRunDuration(result, runStartedAt);
    if (shutdownRequested) {
      await releaseForShutdown();
      return;
    }
    recordWikiIngestModelCost(result);
    await debitWikiIngestModelCost(input.job, resolvedActorUserWorkosId, result);
    if (!leaseActive) {
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      return;
    }
    if (result.skipped) {
      const skipped = await runSpan.runInContext(() =>
        withSpan(SPANS.wikiIngestComplete, baseAttributes, () =>
          store.skip({
            id: input.job.id,
            sourceItemId: input.job.sourceItemId,
            leaseId,
            leaseOwner,
            reason: skippedReason(resultWithDuration),
            result: resultWithDuration,
            traceRef,
            now: new Date(),
          }),
        ),
      );
      if (!skipped) {
        leaseActive = false;
        finishTelemetry("aborted", {
          "goat.status": "running",
          "goat.failure_category": "lease_lost",
        });
        return;
      }
      finishTelemetry("skipped", {
        "goat.status": "skipped",
        ...budgetAttributes(result),
      });
      return;
    }
    const completed = await runSpan.runInContext(() =>
      withSpan(SPANS.wikiIngestComplete, baseAttributes, () =>
        store.complete({
          id: input.job.id,
          sourceItemId: input.job.sourceItemId,
          leaseId,
          leaseOwner,
          result: resultWithDuration,
          traceRef,
          now: new Date(),
        }),
      ),
    );
    if (!completed) {
      leaseActive = false;
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      return;
    }
    finishTelemetry("success", {
      "goat.status": "succeeded",
      ...budgetAttributes(result),
    });
  } catch (error) {
    if (shutdownRequested) {
      await releaseForShutdown();
      return;
    }
    if (error instanceof WikiIngestBudgetError) {
      recordWikiIngestModelCost(error.result);
      const debitActor =
        actorUserWorkosId ?? (await resolveActorForDebit(store, input.job).catch(() => null));
      if (debitActor) {
        await debitWikiIngestModelCost(input.job, debitActor, error.result);
      }
    }
    if (!leaseActive) {
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      return;
    }
    const maxAttempts = retryMaxAttempts(error);
    const failureResult =
      error instanceof WikiIngestBudgetError
        ? withRunDuration({ ...error.result }, runStartedAt)
        : undefined;
    const active = await runSpan.runInContext(() =>
      withSpan(SPANS.wikiIngestFail, baseAttributes, () =>
        store.fail({
          id: input.job.id,
          sourceItemId: input.job.sourceItemId,
          leaseId,
          leaseOwner,
          attempts: input.job.attempts,
          error: errorMessage(error),
          maxAttempts,
          ...(failureResult ? { result: failureResult } : {}),
          traceRef,
          now: new Date(),
        }),
      ),
    );
    if (!active) {
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      return;
    }
    finishTelemetry(
      "failure",
      {
        "goat.status": input.job.attempts >= maxAttempts ? "failed" : "queued",
        ...(error instanceof WikiIngestBudgetError ? budgetAttributes(error.result) : {}),
      },
      error,
    );
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    input.signal?.removeEventListener("abort", requestShutdownHandoff);
    await flushBraintrust();
    await flushLatitude();
  }
}

export function retryMaxAttempts(error: unknown) {
  if (error instanceof WikiIngestBudgetError) return WIKI_INGEST_BUDGET_MAX_ATTEMPTS;
  if (error instanceof WikiAgentOutcomeError) return WIKI_INGEST_OUTCOME_MAX_ATTEMPTS;
  return WIKI_INGEST_MAX_ATTEMPTS;
}

export function startWikiIngestWorker(
  env: RunnerEnv,
  options: {
    store?: WikiIngestStore;
    concurrency?: number;
    pollIntervalMs?: number;
  } = {},
) {
  const store = options.store ?? createDbWikiIngestStore();
  const concurrency = Math.max(1, options.concurrency ?? Math.min(2, env.workerConcurrency));
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? WIKI_INGEST_POLL_INTERVAL_MS);
  const active = new Set<Promise<void>>();
  const worker = createPollingWorker({
    pollIntervalMs,
    poll: async ({ signal, stopping }) => {
      while (!stopping() && active.size < concurrency) {
        signal.throwIfAborted();
        const job = await claimWikiIngestJob({
          leaseOwner: env.instanceId,
          store,
          leaseTtlMs: WIKI_INGEST_LEASE_TTL_MS,
        });
        if (!job) break;
        const running = runClaimedWikiIngestJob({ job, env, store, signal })
          .catch((error) => {
            captureException(error, {
              event: "opencompany.goat_wiki_ingest_job_failed",
              job_id: job.id,
            });
            logger.error("opencompany wiki ingest job failed", {
              event: "opencompany.goat_wiki_ingest_job_failed",
              job_id: job.id,
              error,
            });
          })
          .finally(() => active.delete(running));
        active.add(running);
      }
    },
    onError: (error) => {
      captureException(error, { event: "opencompany.goat_wiki_ingest_worker_failed" });
      logger.error("opencompany wiki ingest worker failed", {
        event: "opencompany.goat_wiki_ingest_worker_failed",
        error,
      });
    },
    drain: async () => {
      await Promise.allSettled(Array.from(active));
    },
  });
  return {
    ...worker,
    activeCount: () => active.size,
  };
}

function retryTrace(result: Record<string, unknown>) {
  const trace = result.trace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return null;
  const value = trace as Record<string, unknown>;
  if (value.schemaVersion !== "goat.wiki_ingest_trace.v1") return null;
  const budget = value.budget;
  const usage = value.usage;
  if (
    typeof value.model !== "string" ||
    !budget ||
    typeof budget !== "object" ||
    Array.isArray(budget) ||
    !usage ||
    typeof usage !== "object" ||
    Array.isArray(usage)
  ) {
    return null;
  }
  const modelCostUsdMicros = finiteNumber((budget as Record<string, unknown>).modelCostUsdMicros);
  if (modelCostUsdMicros === undefined) return null;
  return {
    model: value.model,
    modelCostUsdMicros,
    usage: usage as Record<string, unknown>,
    triage: wikiIngestTriageTrace(value.triage),
  };
}

function wikiIngestTriageTrace(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const trace = value as Record<string, unknown>;
  const usage = trace.usage;
  if (
    typeof trace.model !== "string" ||
    (trace.decision !== "skip" && trace.decision !== "ingest") ||
    !usage ||
    typeof usage !== "object" ||
    Array.isArray(usage)
  ) {
    return null;
  }
  const modelCostUsdMicros = finiteNumber(trace.modelCostUsdMicros);
  if (modelCostUsdMicros === undefined) return null;
  return {
    model: trace.model,
    decision: trace.decision,
    modelCostUsdMicros,
    usage: usage as Record<string, unknown>,
  };
}

async function debitWikiIngestModelCost(
  job: ClaimedWikiIngestJob,
  actorUserWorkosId: string,
  result: Record<string, unknown>,
) {
  try {
    const trace = retryTrace(result);
    if (!trace || trace.modelCostUsdMicros <= 0) return;
    const platformFeeUsdMicros = calculatePlatformFeeUsdMicros(trace.modelCostUsdMicros);
    await recordCreditDebit({
      workspaceId: job.workspaceId,
      userWorkosId: actorUserWorkosId,
      source: "ingest_model_usage",
      idempotencyKey: `wiki_ingest_model:${job.id}:${job.attempts}`,
      providerCostUsdMicros: trace.modelCostUsdMicros,
      platformFeeUsdMicros,
      totalCostUsdMicros: trace.modelCostUsdMicros + platformFeeUsdMicros,
      costBasis: {
        kind: "ingest_model_usage",
        surface: "wiki_ingest",
        model: trace.model,
        attempt: job.attempts,
        modelCostUsdMicros: trace.modelCostUsdMicros,
        usage: trace.usage,
        ...(trace.triage
          ? {
              triage: {
                model: trace.triage.model,
                decision: trace.triage.decision,
                modelCostUsdMicros: trace.triage.modelCostUsdMicros,
                usage: trace.triage.usage,
              },
            }
          : {}),
      },
      metadata: { wikiIngestJobId: job.id },
    });
  } catch (error) {
    logger.warn("opencompany wiki ingest model debit failed", {
      event: "opencompany.goat_wiki_ingest_debit_failed",
      job_id: job.id,
      workspace_id: job.workspaceId,
      error,
    });
  }
}

function recordWikiIngestModelCost(result: Record<string, unknown>) {
  const trace = retryTrace(result);
  if (!trace) return;
  if (trace.triage) {
    recordWikiIngestModelUsageCost(trace.triage.model, trace.triage.usage);
  }
  // A triage skip mirrors the triage model and usage at the top level because
  // there was no full librarian call. Do not record that same call twice.
  if (trace.triage?.decision === "skip") return;
  recordWikiIngestModelUsageCost(trace.model, trace.usage);
}

function recordWikiIngestModelUsageCost(model: string, usage: Record<string, unknown>) {
  const inputTokens = finiteNumber(usage.inputTokens) ?? 0;
  const inputCacheReadTokens = finiteNumber(usage.cacheReadInputTokens) ?? 0;
  const inputCacheWriteTokens = finiteNumber(usage.cacheWriteInputTokens) ?? 0;
  const cost = calculateModelUsageCost({
    modelName: model,
    inputTokens,
    inputNoCacheTokens: Math.max(inputTokens - inputCacheReadTokens - inputCacheWriteTokens, 0),
    inputCacheReadTokens,
    inputCacheWriteTokens,
    outputTokens: finiteNumber(usage.outputTokens) ?? 0,
  });
  recordModelCost({
    costUsdMicros: cost.totalCostUsdMicros,
    attributes: {
      "goat.model": model,
      "goat.surface": "wiki_ingest",
    },
  });
}

function resolveActorForDebit(store: WikiIngestStore, job: ClaimedWikiIngestJob) {
  return store
    .resolveSource({
      integrationId: job.integrationId,
      workspaceId: job.workspaceId,
      sourceProvider: job.sourceProvider,
    })
    .then((source) => source.actorUserWorkosId);
}

function requireJobLease(job: ClaimedWikiIngestJob, field: "leaseId" | "leaseOwner") {
  const value = job[field];
  if (!value) throw new Error(`Claimed wiki ingest job ${job.id} is missing ${field}.`);
  return value;
}

function withRunDuration<T extends Record<string, unknown>>(result: T, startedAt: number) {
  return {
    ...result,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function skippedReason(result: Record<string, unknown>) {
  if (typeof result.reason === "string" && result.reason.trim()) return result.reason.trim();
  if (
    typeof result.summary === "string" &&
    result.summary.trim() &&
    result.summary.trim() !== WIKI_AGENT_SKIP_SENTINEL
  ) {
    return result.summary.trim();
  }
  return null;
}

function retryBudget(result: Record<string, unknown>) {
  const budget = result.budget;
  return budget && typeof budget === "object" && !Array.isArray(budget)
    ? (budget as Record<string, unknown>)
    : null;
}

function budgetAttributes(result: Record<string, unknown>): TelemetryAttributes {
  const budget = retryBudget(result);
  if (!budget) return {};
  return {
    "goat.budget_limit_usd_micros": finiteNumber(budget.limitUsdMicros),
    "goat.budget_stop_threshold_usd_micros": finiteNumber(budget.stopThresholdUsdMicros),
    "goat.model_cost_usd_micros": finiteNumber(budget.modelCostUsdMicros),
    "goat.total_cost_usd_micros": finiteNumber(budget.totalCostUsdMicros),
    "goat.budget_accounting_complete": budget.accountingComplete === true,
    "goat.budget_exhausted": budget.exhausted === true,
  };
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown wiki ingestion error.";
}
