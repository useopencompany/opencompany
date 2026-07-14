import { randomUUID } from "node:crypto";
import { calculateModelUsageCost } from "@opencompany/billing";
import { releasePendingGoatIngestionReservations } from "@opencompany/db/goat-billing";
import {
  goatBrainFilePathFor,
  listGoatBrainFiles,
  upsertGoatBrainFile,
} from "@opencompany/db/goat-brain-files";
import { normalizeGoatBrainIngestTrace } from "@opencompany/db/goat-brain-ingest-trace";
import {
  type GoatBrainIngestJob,
  type GoatBrainIngestJobKind,
  type GoatBrainSourceProvider,
  type GoatBrainSourceType,
} from "@opencompany/db/goat-schema";
import { getDefaultGoatBrainForUser } from "@opencompany/db/goat-workspaces";
import {
  isNormalizedGitHubActivitySourceItem,
  isNormalizedGmailThreadSourceItem,
  isNormalizedGoatChatCaptureSourceItem,
  isNormalizedGoogleDriveDocumentSourceItem,
  isNormalizedJamieMeetingSourceItem,
  isNormalizedLinearIssueSourceItem,
  isNormalizedSlackConversationSourceItem,
  isNormalizedUploadAssetSourceItem,
  type NormalizedBrainSourceItem,
  type NormalizedJamieMeetingSourceItem,
} from "@opencompany/goat-brain";
import {
  GOAT_SPANS,
  type GoatAttributes,
  hashGoatUserId,
  recordGoatBrainIngestRun,
  recordGoatModelCost,
  startGoatSpan,
  withGoatSpan,
} from "@opencompany/goat-observability";
import { captureException, createLogger } from "@opencompany/observability";
import { flushBraintrust, traceBraintrust } from "@opencompany/observability/braintrust";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import {
  GOAT_BRAIN_AGENT_INGEST_TIMEOUT_MS,
  GOAT_BRAIN_AGENT_SKIP_SENTINEL,
  type GoatBrainAgentIngestEnv,
  GoatBrainAgentOutcomeError,
  runGitHubActivityAgentIngest,
  runGmailThreadAgentIngest,
  runGoatChatCaptureAgentIngest,
  runGoogleDriveDocumentAgentIngest,
  runJamieMeetingAgentIngest,
  runLinearIssueAgentIngest,
  runSlackConversationAgentIngest,
  runUploadAssetAgentIngest,
} from "./goat-brain-agent-ingest";
import {
  buildJamieMeetingBrainWrites,
  JAMIE_EVIDENCE_FOLDER,
  JAMIE_MEETING_FOLDER,
} from "./goat-brain-jamie-writes";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-brain-ingest" });

// A running job's lease must outlive one full agent-ingest attempt so a transient
// heartbeat outage (DB blip, brief event-loop stall) can't let a second worker
// re-claim and double-run a job that is still executing. The agent self-aborts at
// GOAT_BRAIN_AGENT_INGEST_TIMEOUT_MS, which stays comfortably inside this window.
// Intentionally decoupled from the shared RUNNER_JOB_LEASE_TTL_MS: brain ingests run
// far longer than typical leased jobs and a delayed retry on a genuinely dead worker
// is preferable to concurrent double-processing.
export const GOAT_BRAIN_INGEST_LEASE_BUFFER_MS = 2 * 60 * 1000;
export const GOAT_BRAIN_INGEST_LEASE_TTL_MS =
  GOAT_BRAIN_AGENT_INGEST_TIMEOUT_MS + GOAT_BRAIN_INGEST_LEASE_BUFFER_MS;
export const GOAT_BRAIN_INGEST_HEARTBEAT_INTERVAL_MS = 5_000;
export const GOAT_BRAIN_INGEST_MAX_ATTEMPTS = 5;
// Agent-outcome failures (ran to completion, wrote nothing, did not skip) are
// near-deterministic on identical content: one retry covers model
// nondeterminism, further ones just burn full agent runs. Infrastructure
// failures keep the full budget above.
export const GOAT_BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS = 2;
const GOAT_BRAIN_INGEST_POLL_INTERVAL_MS = 5_000;
// Per-entry cap for result.attemptErrors; the full text of the latest failure
// still lives in last_error.
const ATTEMPT_ERROR_MAX_CHARS = 500;

export type GoatBrainIngestJobWithSource = Omit<
  GoatBrainIngestJob,
  "workspaceId" | "planPaused"
> & {
  workspaceId?: string | null;
  planPaused?: boolean;
  sourceType: GoatBrainSourceType;
  normalizedPayload: unknown;
};

export type GoatBrainIngestJobDescriptor = {
  kind: GoatBrainIngestJobKind;
  sourceProvider: GoatBrainSourceProvider;
  sourceType: GoatBrainSourceType;
};

export type GoatBrainIngestHandlerInput<
  TItem extends NormalizedBrainSourceItem = NormalizedBrainSourceItem,
> = {
  jobId: string;
  userWorkosId: string;
  brainRef: string | null;
  // The integration the source item came through, when the source has one.
  // Lets handlers look up per-(brain, integration) source config live at
  // ingest time (e.g. Gmail ingestion instructions).
  integrationId: string | null;
  item: TItem;
  env: GoatBrainAgentIngestEnv;
};

export type GoatBrainIngestHandler<
  TItem extends NormalizedBrainSourceItem = NormalizedBrainSourceItem,
> = {
  descriptor: GoatBrainIngestJobDescriptor;
  isPayload(value: unknown): value is TItem;
  run(input: GoatBrainIngestHandlerInput<TItem>): Promise<Record<string, unknown>>;
};

// Legacy deterministic template writer; kept registered so already-queued jobs
// drain. New Jamie webhooks enqueue the agentic kind below.
const JAMIE_MEETING_INGEST_DESCRIPTOR = {
  kind: "brain_source_item_ingest",
  sourceProvider: "jamie",
  sourceType: "meeting",
} as const satisfies GoatBrainIngestJobDescriptor;

const JAMIE_MEETING_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "jamie",
  sourceType: "meeting",
} as const satisfies GoatBrainIngestJobDescriptor;

const GOAT_CHAT_CAPTURE_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "goat-chat",
  sourceType: "capture",
} as const satisfies GoatBrainIngestJobDescriptor;

const UPLOAD_ASSET_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "upload",
  sourceType: "asset",
} as const satisfies GoatBrainIngestJobDescriptor;

const SLACK_CONVERSATION_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "slack",
  sourceType: "conversation",
} as const satisfies GoatBrainIngestJobDescriptor;

const LINEAR_ISSUE_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "linear",
  sourceType: "issue",
} as const satisfies GoatBrainIngestJobDescriptor;

const GITHUB_ACTIVITY_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "github",
  sourceType: "activity",
} as const satisfies GoatBrainIngestJobDescriptor;

const GMAIL_THREAD_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "gmail",
  sourceType: "thread",
} as const satisfies GoatBrainIngestJobDescriptor;

const GOOGLE_DRIVE_DOCUMENT_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "google_drive",
  sourceType: "document",
} as const satisfies GoatBrainIngestJobDescriptor;

const GOAT_BRAIN_INGEST_HANDLERS: readonly GoatBrainIngestHandler[] = [
  {
    descriptor: JAMIE_MEETING_INGEST_DESCRIPTOR,
    isPayload: isNormalizedJamieMeetingSourceItem,
    run: runTypedGoatBrainIngestHandler(writeJamieMeetingToBrain),
  },
  {
    descriptor: JAMIE_MEETING_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedJamieMeetingSourceItem,
    run: runTypedGoatBrainIngestHandler(runJamieMeetingAgentIngest),
  },
  {
    descriptor: GOAT_CHAT_CAPTURE_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedGoatChatCaptureSourceItem,
    run: runTypedGoatBrainIngestHandler(runGoatChatCaptureAgentIngest),
  },
  {
    descriptor: UPLOAD_ASSET_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedUploadAssetSourceItem,
    run: runTypedGoatBrainIngestHandler(runUploadAssetAgentIngest),
  },
  {
    descriptor: SLACK_CONVERSATION_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedSlackConversationSourceItem,
    run: runTypedGoatBrainIngestHandler(runSlackConversationAgentIngest),
  },
  {
    descriptor: LINEAR_ISSUE_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedLinearIssueSourceItem,
    run: runTypedGoatBrainIngestHandler(runLinearIssueAgentIngest),
  },
  {
    descriptor: GITHUB_ACTIVITY_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedGitHubActivitySourceItem,
    run: runTypedGoatBrainIngestHandler(runGitHubActivityAgentIngest),
  },
  {
    descriptor: GMAIL_THREAD_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedGmailThreadSourceItem,
    run: runTypedGoatBrainIngestHandler(runGmailThreadAgentIngest),
  },
  {
    descriptor: GOOGLE_DRIVE_DOCUMENT_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedGoogleDriveDocumentSourceItem,
    run: runTypedGoatBrainIngestHandler(runGoogleDriveDocumentAgentIngest),
  },
];

function runTypedGoatBrainIngestHandler<TItem extends NormalizedBrainSourceItem>(
  run: (input: GoatBrainIngestHandlerInput<TItem>) => Promise<Record<string, unknown>>,
): GoatBrainIngestHandler["run"] {
  return (input) => run(input as GoatBrainIngestHandlerInput<TItem>);
}

export type GoatBrainIngestStore = {
  claimNext(input: {
    leaseId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
    supportedJobs: readonly GoatBrainIngestJobDescriptor[];
  }): Promise<GoatBrainIngestJobWithSource | null>;
  heartbeat(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  complete(input: {
    id: string;
    sourceItemId: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    result: Record<string, unknown>;
  }): Promise<boolean>;
  skip(input: {
    id: string;
    sourceItemId: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    result: Record<string, unknown>;
    reason: string | null;
  }): Promise<boolean>;
  fail(input: {
    id: string;
    sourceItemId: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    attempts: number;
    error: string;
    maxAttempts?: number;
  }): Promise<boolean>;
};

export function createDbGoatBrainIngestStore(): GoatBrainIngestStore {
  return {
    async claimNext(input) {
      const supportedJobsWhere = supportedJobDescriptorsWhere(input.supportedJobs);
      const result = await getDb().execute(sql`
        WITH candidate AS (
          SELECT job.id
          FROM goat.brain_ingest_jobs AS job
          INNER JOIN goat.brain_source_items AS source ON source.id = job.source_item_id
          LEFT JOIN goat.workspace_ingestion_reservations AS reservation
            ON reservation.workspace_id = job.workspace_id
           AND reservation.source_item_id = job.source_item_id
          WHERE
            (
              (job.status = 'queued' AND job.next_run_at <= ${input.now})
              OR (job.status = 'running' AND job.lease_expires_at < ${input.now})
            )
            AND (${supportedJobsWhere})
            -- Legacy jobs without workspace attribution predate plan quotas and
            -- remain runnable. Every new workspace-attributed job requires a
            -- consumed reservation; pending reservations are the durable pause.
            AND (job.workspace_id IS NULL OR reservation.status = 'consumed')
            -- Serialize ingest runs per brain: agent runs materialize the whole
            -- brain and sync it back, so two concurrent runs against the same
            -- brain conflict on shared pages and waste full agent attempts.
            -- Jobs for other brains stay claimable. NULL brain_ref resolves to
            -- the user's default brain at run time, so NULLs serialize per user
            -- via IS NOT DISTINCT FROM.
            AND NOT EXISTS (
              SELECT 1
              FROM goat.brain_ingest_jobs AS running
              WHERE running.status = 'running'
                AND running.lease_expires_at >= ${input.now}
                AND running.id <> job.id
                AND running.user_workos_id = job.user_workos_id
                AND running.brain_ref IS NOT DISTINCT FROM job.brain_ref
            )
          ORDER BY job.next_run_at ASC, job.created_at ASC
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
        ),
        claimed AS (
          UPDATE goat.brain_ingest_jobs AS job
          SET status = 'running',
              plan_paused = false,
              attempts = job.attempts + 1,
              lease_id = ${input.leaseId},
              lease_owner = ${input.leaseOwner},
              lease_expires_at = ${input.leaseExpiresAt},
              updated_at = ${input.now}
          FROM candidate
          WHERE job.id = candidate.id
          RETURNING ${goatBrainIngestJobColumnsSql}
        )
        SELECT
          claimed.*,
          source.source_type AS "sourceType",
          source.normalized_payload AS "normalizedPayload"
        FROM claimed
        INNER JOIN goat.brain_source_items AS source ON source.id = claimed."sourceItemId"
      `);
      return rowsFromExecute<GoatBrainIngestJobWithSource>(result)[0] ?? null;
    },

    async heartbeat(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.brain_ingest_jobs
        SET lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async complete(input) {
      const resultJson = JSON.stringify(input.result);
      const result = await getDb().execute(sql`
        WITH completed_job AS (
          UPDATE goat.brain_ingest_jobs
          SET status = 'succeeded',
              lease_id = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              -- Keep the per-attempt error history a retried job accumulated;
              -- without it a succeeded job carries no trace of why earlier
              -- attempts failed.
              result = ${resultJson}::jsonb
                || jsonb_strip_nulls(jsonb_build_object('attemptErrors', result->'attemptErrors')),
              completed_at = ${input.now},
              updated_at = ${input.now}
          WHERE id = ${input.id}
            AND source_item_id = ${input.sourceItemId}
            AND lease_id = ${input.leaseId}
            AND lease_owner = ${input.leaseOwner}
            AND status = 'running'
          RETURNING id, source_item_id
        ),
        updated_source AS (
          UPDATE goat.brain_source_items AS source
          SET last_ingest_status = 'succeeded',
              last_ingested_at = ${input.now},
              last_ingest_error = NULL,
              updated_at = ${input.now}
          FROM completed_job
          WHERE source.id = completed_job.source_item_id
          RETURNING source.id
        )
        SELECT id FROM completed_job
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async skip(input) {
      const resultJson = JSON.stringify(input.result);
      const result = await getDb().execute(sql`
        WITH skipped_job AS (
          UPDATE goat.brain_ingest_jobs
          SET status = 'skipped',
              lease_id = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              result = ${resultJson}::jsonb
                || jsonb_strip_nulls(jsonb_build_object('attemptErrors', result->'attemptErrors')),
              completed_at = ${input.now},
              updated_at = ${input.now}
          WHERE id = ${input.id}
            AND source_item_id = ${input.sourceItemId}
            AND lease_id = ${input.leaseId}
            AND lease_owner = ${input.leaseOwner}
            AND status = 'running'
          RETURNING id, source_item_id
        ),
        updated_source AS (
          UPDATE goat.brain_source_items AS source
          SET last_ingest_status = 'skipped',
              last_ingested_at = ${input.now},
              last_ingest_error = ${input.reason},
              updated_at = ${input.now}
          FROM skipped_job
          WHERE source.id = skipped_job.source_item_id
          RETURNING source.id
        )
        SELECT id FROM skipped_job
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async fail(input) {
      const terminal = input.attempts >= (input.maxAttempts ?? GOAT_BRAIN_INGEST_MAX_ATTEMPTS);
      const nextRunAt = terminal ? input.now : nextRetryAt(input.now, input.attempts);
      // Append this attempt's error to result.attemptErrors so retry causes
      // survive the retries (last_error alone is overwritten per attempt and
      // cleared when a later attempt succeeds or skips).
      const attemptErrorJson = JSON.stringify([
        {
          attempt: input.attempts,
          at: input.now.toISOString(),
          error: input.error.slice(0, ATTEMPT_ERROR_MAX_CHARS),
        },
      ]);
      const result = await getDb().execute(sql`
        WITH failed_job AS (
          UPDATE goat.brain_ingest_jobs
          SET status = ${terminal ? "failed" : "queued"},
              lease_id = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_run_at = ${nextRunAt},
              last_error = ${input.error},
              result = result || jsonb_build_object(
                'attemptErrors',
                COALESCE(result->'attemptErrors', '[]'::jsonb) || ${attemptErrorJson}::jsonb
              ),
              completed_at = ${terminal ? input.now : null},
              updated_at = ${input.now}
          WHERE id = ${input.id}
            AND source_item_id = ${input.sourceItemId}
            AND lease_id = ${input.leaseId}
            AND lease_owner = ${input.leaseOwner}
            AND status = 'running'
          RETURNING id, source_item_id
        ),
        updated_source AS (
          UPDATE goat.brain_source_items AS source
          SET last_ingest_status = ${terminal ? "failed" : "pending"},
              last_ingest_error = ${input.error},
              updated_at = ${input.now}
          FROM failed_job
          WHERE source.id = failed_job.source_item_id
          RETURNING source.id
        )
        SELECT id FROM failed_job
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },
  };
}

let registeredGoatBrainIngestWakeup: (() => void) | null = null;

export function setGoatBrainIngestWakeup(wake: (() => void) | null) {
  registeredGoatBrainIngestWakeup = wake;
}

export function wakeGoatBrainIngestWorker() {
  registeredGoatBrainIngestWakeup?.();
}

export async function claimNextGoatBrainIngestJob(input: {
  leaseOwner: string;
  supportedJobs: readonly GoatBrainIngestJobDescriptor[];
  store?: GoatBrainIngestStore;
  leaseTtlMs?: number;
}) {
  const now = new Date();
  const leaseId = newGoatBrainIngestLeaseId();
  const store = input.store ?? createDbGoatBrainIngestStore();
  if (!input.store) {
    await releasePendingGoatIngestionReservations({ now, maxWorkspaces: 50 });
  }
  return store.claimNext({
    leaseId,
    leaseOwner: input.leaseOwner,
    now,
    leaseExpiresAt: new Date(now.getTime() + (input.leaseTtlMs ?? GOAT_BRAIN_INGEST_LEASE_TTL_MS)),
    supportedJobs: input.supportedJobs,
  });
}

export async function runClaimedGoatBrainIngestJob(input: {
  job: GoatBrainIngestJobWithSource;
  env: Pick<RunnerEnv, "jobLeaseTtlMs" | "vercelAiGatewayApiKey"> & {
    blobReadWriteToken?: RunnerEnv["blobReadWriteToken"];
    exaApiKey?: RunnerEnv["exaApiKey"];
  };
  handlers?: readonly GoatBrainIngestHandler[];
  store?: GoatBrainIngestStore;
}) {
  const runStartedAt = performance.now();
  const store = input.store ?? createDbGoatBrainIngestStore();
  const handlers = input.handlers ?? GOAT_BRAIN_INGEST_HANDLERS;
  const leaseId = requireJobLease(input.job, "leaseId");
  const leaseOwner = requireJobLease(input.job, "leaseOwner");
  const userIdHash = hashGoatUserId(input.job.userWorkosId);
  const baseAttributes = {
    ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
    "goat.brain_ingest_job_id": input.job.id,
    "goat.brain_source_item_id": input.job.sourceItemId,
    "goat.brain_ref": input.job.brainRef ?? undefined,
    "goat.ingest_kind": input.job.kind,
    "goat.source_provider": input.job.sourceProvider,
    "goat.source_type": input.job.sourceType,
    "goat.status": input.job.status,
    "goat.attempt": input.job.attempts,
    "goat.lease_owner": leaseOwner,
  } satisfies GoatAttributes;
  const runSpan = startGoatSpan(GOAT_SPANS.brainIngestRun, baseAttributes);
  let leaseActive = true;
  let telemetryFinished = false;

  const finishTelemetry = (
    outcome: "success" | "failure" | "aborted" | "skipped",
    attributes: GoatAttributes = {},
    error?: unknown,
  ) => {
    if (telemetryFinished) return;
    telemetryFinished = true;
    const durationMs = Math.round(performance.now() - runStartedAt);
    const failureCategory =
      outcome === "failure" && error
        ? runSpan.fail(error, attributes)
        : (attributes["goat.failure_category"] as string | undefined);
    const finalAttributes = {
      ...baseAttributes,
      "goat.outcome": outcome,
      ...(failureCategory ? { "goat.failure_category": failureCategory } : {}),
      ...attributes,
    };
    runSpan.end(finalAttributes);
    recordGoatBrainIngestRun({
      durationMs,
      outcome,
      attributes: finalAttributes,
    });
    const logFields = {
      event: "opencompany.goat_brain_ingest_run_finished",
      outcome,
      ...(failureCategory ? { failure_category: failureCategory } : {}),
      job_id: input.job.id,
      source_item_id: input.job.sourceItemId,
      brain_ref: input.job.brainRef,
      kind: input.job.kind,
      source_provider: input.job.sourceProvider,
      source_type: input.job.sourceType,
      status: finalAttributes["goat.status"],
      attempts: input.job.attempts,
      duration_ms: durationMs,
    };
    if (outcome === "success" || outcome === "skipped") {
      logger.info("Goat Brain ingest job finished", logFields);
    } else {
      logger.warn("Goat Brain ingest job finished", logFields);
    }
  };

  const heartbeat = async () => {
    const now = new Date();
    const active = await store.heartbeat({
      id: input.job.id,
      leaseId,
      leaseOwner,
      now,
      leaseExpiresAt: new Date(now.getTime() + GOAT_BRAIN_INGEST_LEASE_TTL_MS),
    });
    if (!active) leaseActive = false;
  };

  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      captureException(error, {
        event: "opencompany.goat_brain_ingest_heartbeat_failed",
        job_id: input.job.id,
      });
      logger.warn("Goat Brain ingest heartbeat failed", {
        event: "opencompany.goat_brain_ingest_heartbeat_failed",
        job_id: input.job.id,
        error,
      });
      leaseActive = false;
    });
  }, GOAT_BRAIN_INGEST_HEARTBEAT_INTERVAL_MS);

  try {
    const handler = findGoatBrainIngestHandler(handlers, input.job);
    if (!handler) {
      throw new Error(
        `Unsupported Goat Brain ingest source: ${input.job.kind}/${input.job.sourceProvider}/${input.job.sourceType}`,
      );
    }
    const normalizedPayload = input.job.normalizedPayload;
    if (!handler.isPayload(normalizedPayload)) {
      throw new Error(
        `Goat Brain ingest job has an invalid ${input.job.sourceProvider}/${input.job.sourceType} normalized payload.`,
      );
    }
    if (normalizedPayload.contentHash !== input.job.contentHash) {
      throw new Error("Goat Brain ingest job content hash does not match its source payload.");
    }

    // Open one Braintrust root span per job run so every model + tool span the
    // handler emits nests under a single trace. Without a root, wrapAISDK (logger
    // is setCurrent:false) starts each generateText as its own root, fragmenting
    // one ingestion across many trace ids.
    const result = await runSpan.runInContext(() =>
      traceBraintrust(
        {
          name: GOAT_SPANS.brainIngestRun,
          type: "task",
          metadata: {
            job_id: input.job.id,
            source_item_id: input.job.sourceItemId,
            brain_ref: input.job.brainRef ?? null,
            kind: input.job.kind,
            source_provider: input.job.sourceProvider,
            source_type: input.job.sourceType,
            attempt: input.job.attempts,
            ...(userIdHash ? { user_id_hash: userIdHash } : {}),
          },
        },
        () =>
          handler.run({
            jobId: input.job.id,
            userWorkosId: input.job.userWorkosId,
            brainRef: input.job.brainRef ?? null,
            integrationId: input.job.integrationId ?? null,
            item: normalizedPayload,
            env: {
              vercelAiGatewayApiKey: input.env.vercelAiGatewayApiKey,
              blobReadWriteToken: input.env.blobReadWriteToken,
              exaApiKey: input.env.exaApiKey,
            },
          }),
      ),
    );
    recordBrainIngestModelCost(result);
    if (!leaseActive) {
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      return;
    }
    if (isSkippedIngestResult(result)) {
      const skipped = await runSpan.runInContext(() =>
        withGoatSpan(GOAT_SPANS.brainIngestComplete, baseAttributes, () =>
          store.skip({
            id: input.job.id,
            sourceItemId: input.job.sourceItemId,
            leaseId,
            leaseOwner,
            now: new Date(),
            result,
            reason: skippedIngestReason(result),
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
      });
      return;
    }
    const completed = await runSpan.runInContext(() =>
      withGoatSpan(GOAT_SPANS.brainIngestComplete, baseAttributes, () =>
        store.complete({
          id: input.job.id,
          sourceItemId: input.job.sourceItemId,
          leaseId,
          leaseOwner,
          now: new Date(),
          result,
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
    });
  } catch (error) {
    const message = errorMessage(error);
    const maxAttempts =
      error instanceof GoatBrainAgentOutcomeError
        ? GOAT_BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS
        : GOAT_BRAIN_INGEST_MAX_ATTEMPTS;
    const terminal = input.job.attempts >= maxAttempts;
    const active = await runSpan.runInContext(() =>
      withGoatSpan(GOAT_SPANS.brainIngestFail, baseAttributes, () =>
        store.fail({
          id: input.job.id,
          sourceItemId: input.job.sourceItemId,
          leaseId,
          leaseOwner,
          now: new Date(),
          attempts: input.job.attempts,
          error: message,
          maxAttempts,
        }),
      ),
    );
    if (!active || !leaseActive) {
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      throw error;
    }
    finishTelemetry("failure", { "goat.status": terminal ? "failed" : "queued" }, error);
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    // Flush the job's spans promptly; the runner is long-lived and may not shut
    // down (its only other flush point) for a long time. No-ops when disabled.
    await flushBraintrust();
  }
}

function recordBrainIngestModelCost(result: Record<string, unknown>) {
  const trace = normalizeGoatBrainIngestTrace(result.trace);
  if (!trace) return;

  const inputTokens = trace.usage.inputTokens ?? 0;
  const inputCacheReadTokens = trace.usage.cacheReadInputTokens ?? 0;
  const inputCacheWriteTokens = trace.usage.cacheWriteInputTokens ?? 0;
  const cost = calculateModelUsageCost({
    modelName: trace.model,
    inputTokens,
    inputNoCacheTokens: Math.max(inputTokens - inputCacheReadTokens - inputCacheWriteTokens, 0),
    inputCacheReadTokens,
    inputCacheWriteTokens,
    outputTokens: trace.usage.outputTokens ?? 0,
  });

  recordGoatModelCost({
    costUsdMicros: cost.totalCostUsdMicros,
    attributes: {
      "goat.model": trace.model,
      "goat.surface": "brain_ingest",
    },
  });
}

export function startGoatBrainIngestWorker(
  env: RunnerEnv,
  options: {
    store?: GoatBrainIngestStore;
    concurrency?: number;
    pollIntervalMs?: number;
  } = {},
) {
  const store = options.store ?? createDbGoatBrainIngestStore();
  const handlers = GOAT_BRAIN_INGEST_HANDLERS;
  const supportedJobs = handlers.map((handler) => handler.descriptor);
  const concurrency = Math.max(1, options.concurrency ?? Math.min(2, env.workerConcurrency));
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? GOAT_BRAIN_INGEST_POLL_INTERVAL_MS);
  const active = new Set<Promise<void>>();
  let stopped = false;
  let pendingWake = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    if (wake) {
      wake();
    } else {
      pendingWake = true;
    }
  };

  const waitForPollOrWake = () => {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  };

  const runLoop = async () => {
    while (!stopped) {
      try {
        while (!stopped && active.size < concurrency) {
          const job = await claimNextGoatBrainIngestJob({
            leaseOwner: env.instanceId,
            supportedJobs,
            store,
            leaseTtlMs: GOAT_BRAIN_INGEST_LEASE_TTL_MS,
          });
          if (!job) break;
          const running = runClaimedGoatBrainIngestJob({ job, env, handlers, store })
            .catch((error) => {
              captureException(error, {
                event: "opencompany.goat_brain_ingest_job_failed",
                job_id: job.id,
              });
              logger.error("Goat Brain ingest job failed", {
                event: "opencompany.goat_brain_ingest_job_failed",
                job_id: job.id,
                error,
              });
            })
            .finally(() => active.delete(running));
          active.add(running);
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_brain_ingest_worker_failed" });
        logger.error("Goat Brain ingest worker failed", {
          event: "opencompany.goat_brain_ingest_worker_failed",
          error,
        });
      }
      if (stopped) break;
      await waitForPollOrWake();
    }
  };

  const loop = runLoop();
  return {
    notify,
    activeCount: () => active.size,
    stop: async () => {
      stopped = true;
      notify();
      await loop;
      await Promise.allSettled(Array.from(active));
    },
  };
}

export async function writeJamieMeetingToBrain(input: {
  userWorkosId: string;
  brainRef: string | null;
  item: NormalizedJamieMeetingSourceItem;
  env: GoatBrainAgentIngestEnv;
}) {
  const writes = buildJamieMeetingBrainWrites(input.item);
  const db = getDb();
  // Legacy jobs predate per-job brain refs; they land in the user's default
  // ("General") brain.
  const brainRef =
    input.brainRef ?? (await getDefaultGoatBrainForUser(input.userWorkosId, { db }))?.id;
  if (!brainRef) {
    throw new Error(`No accessible Goat brain found for user ${input.userWorkosId}.`);
  }
  const existingRows = await listGoatBrainFiles({ brainRef }, { db });
  const meetingAlreadyExists = existingRows.some((row) => row.brainId === writes.meetingBrainId);
  const evidence = await upsertGoatBrainFile(
    {
      brainRef,
      userWorkosId: input.userWorkosId,
      path: goatBrainFilePathFor(JAMIE_EVIDENCE_FOLDER, writes.evidenceBrainId),
      content: writes.evidenceContent,
    },
    { db },
  );
  const meeting = await upsertGoatBrainFile(
    {
      brainRef,
      userWorkosId: input.userWorkosId,
      path: goatBrainFilePathFor(JAMIE_MEETING_FOLDER, writes.meetingBrainId),
      content: writes.meetingContent,
    },
    { db },
  );

  return {
    meetingBrainId: writes.meetingBrainId,
    evidenceBrainId: writes.evidenceBrainId,
    meetingDocumentId: meeting.id,
    evidenceDocumentId: evidence.id,
    pages:
      meeting.kind === "page"
        ? [
            {
              brainId: meeting.brainId,
              folderPath: meeting.folderPath,
              title: meeting.title || meeting.brainId,
              action: meetingAlreadyExists ? "updated" : "created",
            },
          ]
        : [],
    truncatedTranscript: writes.truncatedTranscript,
  };
}

function requireJobLease(job: GoatBrainIngestJobWithSource, field: "leaseId" | "leaseOwner") {
  const value = job[field];
  if (!value) throw new Error(`Claimed Goat Brain ingest job ${job.id} is missing ${field}.`);
  return value;
}

function nextRetryAt(now: Date, attempts: number) {
  const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delayMs);
}

function newGoatBrainIngestLeaseId() {
  return `goat_brain_ingest_${randomUUID()}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Goat Brain ingest error.";
}

function isSkippedIngestResult(result: Record<string, unknown>) {
  return result.skipped === true;
}

function skippedIngestReason(result: Record<string, unknown>) {
  const reason = result.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  const summary = result.summary;
  if (
    typeof summary === "string" &&
    summary.trim() &&
    summary.trim() !== GOAT_BRAIN_AGENT_SKIP_SENTINEL
  ) {
    return summary.trim();
  }
  return null;
}

function findGoatBrainIngestHandler(
  handlers: readonly GoatBrainIngestHandler[],
  job: Pick<GoatBrainIngestJobWithSource, "kind" | "sourceProvider" | "sourceType">,
) {
  return handlers.find(
    (handler) =>
      handler.descriptor.kind === job.kind &&
      handler.descriptor.sourceProvider === job.sourceProvider &&
      handler.descriptor.sourceType === job.sourceType,
  );
}

function supportedJobDescriptorsWhere(descriptors: readonly GoatBrainIngestJobDescriptor[]) {
  if (descriptors.length === 0) return sql`FALSE`;
  return sql.join(
    descriptors.map(
      (descriptor) => sql`
        (
          job.kind = ${descriptor.kind}
          AND job.source_provider = ${descriptor.sourceProvider}
          AND source.source_type = ${descriptor.sourceType}
        )
      `,
    ),
    sql` OR `,
  );
}

const goatBrainIngestJobColumnsSql = sql`
  job.id,
  job.source_item_id AS "sourceItemId",
  job.user_workos_id AS "userWorkosId",
  job.source_provider AS "sourceProvider",
  job.source_connection_id AS "sourceConnectionId",
  job.integration_id AS "integrationId",
  job.workspace_id AS "workspaceId",
  job.brain_ref AS "brainRef",
  job.kind,
  job.content_hash AS "contentHash",
  job.status,
  job.plan_paused AS "planPaused",
  job.attempts,
  job.next_run_at AS "nextRunAt",
  job.lease_id AS "leaseId",
  job.lease_owner AS "leaseOwner",
  job.lease_expires_at AS "leaseExpiresAt",
  job.last_error AS "lastError",
  job.result,
  job.completed_at AS "completedAt",
  job.created_at AS "createdAt",
  job.updated_at AS "updatedAt"
`;
