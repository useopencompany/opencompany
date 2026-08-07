import { randomUUID } from "node:crypto";
import { captureModelSpendRecorded, captureServerEvent } from "@opencompany/analytics/server";
import { calculateModelUsageCost, calculatePlatformFeeUsdMicros } from "@opencompany/billing";
import {
  isNormalizedAttioObjectSourceItem,
  isNormalizedBrainPointerSourceItem,
  isNormalizedChatCaptureSourceItem,
  isNormalizedFathomMeetingSourceItem,
  isNormalizedGitHubActivitySourceItem,
  isNormalizedGmailThreadSourceItem,
  isNormalizedGoogleDriveDocumentSourceItem,
  isNormalizedGranolaMeetingSourceItem,
  isNormalizedHubspotObjectSourceItem,
  isNormalizedImportSourceItem,
  isNormalizedJamieMeetingSourceItem,
  isNormalizedLinearIssueSourceItem,
  isNormalizedSlackConversationSourceItem,
  isNormalizedUploadAssetSourceItem,
  type NormalizedBrainPointerSourceItem,
  type NormalizedBrainSourceItem,
  type NormalizedJamieMeetingSourceItem,
} from "@opencompany/brain";
import { releasePendingIngestionReservations } from "@opencompany/db/billing";
import { brainFilePathFor, listBrainFiles, upsertBrainFile } from "@opencompany/db/brain-files";
import { normalizeBrainIngestTrace } from "@opencompany/db/brain-ingest-trace";
import { recordCreditDebit } from "@opencompany/db/credits";
import {
  type BrainIngestJob,
  type BrainIngestJobKind,
  type BrainSourceProvider,
  type BrainSourceType,
} from "@opencompany/db/schema";
import { getDefaultBrainForUser } from "@opencompany/db/workspaces";
import { captureException, createLogger } from "@opencompany/observability";
import { flushBraintrust, traceBraintrust } from "@opencompany/observability/braintrust";
import {
  type Attributes,
  hashUserId,
  recordBrainIngestRun,
  recordModelCost,
  SPANS,
  startSpan,
  withSpan,
} from "@opencompany/telemetry";
import { flushLatitude } from "@opencompany/telemetry/latitude";
import { sql } from "drizzle-orm";
import {
  BRAIN_AGENT_INGEST_TIMEOUT_MS,
  BRAIN_AGENT_SKIP_SENTINEL,
  type BrainAgentIngestEnv,
  BrainAgentOutcomeError,
  BrainIngestBudgetError,
  runAttioObjectAgentIngest,
  runChatCaptureAgentIngest,
  runFathomMeetingAgentIngest,
  runGitHubActivityAgentIngest,
  runGmailThreadAgentIngest,
  runGoogleDriveDocumentAgentIngest,
  runGranolaMeetingAgentIngest,
  runHubspotObjectAgentIngest,
  runImportAgentIngest,
  runJamieMeetingAgentIngest,
  runLinearIssueAgentIngest,
  runSlackConversationAgentIngest,
  runUploadAssetAgentIngest,
} from "./brain-agent-ingest";
import {
  buildJamieMeetingBrainWrites,
  JAMIE_EVIDENCE_FOLDER,
  JAMIE_MEETING_FOLDER,
} from "./brain-jamie-writes";
import { runBrainPointerHydrate } from "./brain-pointer-hydrators";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-brain-ingest",
});

// A running job's lease must outlive one full agent-ingest attempt so a transient
// heartbeat outage (DB blip, brief event-loop stall) can't let a second worker
// re-claim and double-run a job that is still executing. The agent self-aborts at
// BRAIN_AGENT_INGEST_TIMEOUT_MS, which stays comfortably inside this window.
// Intentionally decoupled from the shared RUNNER_JOB_LEASE_TTL_MS: brain ingests run
// far longer than typical leased jobs and a delayed retry on a genuinely dead worker
// is preferable to concurrent double-processing.
export const BRAIN_INGEST_LEASE_BUFFER_MS = 2 * 60 * 1000;
export const BRAIN_INGEST_LEASE_TTL_MS =
  BRAIN_AGENT_INGEST_TIMEOUT_MS + BRAIN_INGEST_LEASE_BUFFER_MS;
export const BRAIN_INGEST_HEARTBEAT_INTERVAL_MS = 5_000;
export const BRAIN_INGEST_MAX_ATTEMPTS = 5;
// Agent-outcome failures (ran to completion, wrote nothing, did not skip) are
// near-deterministic on identical content: one retry covers model
// nondeterminism, further ones just burn full agent runs. Infrastructure
// failures keep the full budget above.
export const BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS = 2;
const BRAIN_INGEST_POLL_INTERVAL_MS = 5_000;
// Per-entry cap for result.attemptErrors; the full text of the latest failure
// still lives in last_error.
const ATTEMPT_ERROR_MAX_CHARS = 500;

export type BrainIngestJobWithSource = Omit<
  BrainIngestJob,
  "workspaceId" | "planPaused" | "importRunId"
> & {
  workspaceId?: string | null;
  planPaused?: boolean;
  importRunId?: string | null;
  sourceType: BrainSourceType;
  normalizedPayload: unknown;
};

export type BrainIngestJobDescriptor = {
  kind: BrainIngestJobKind;
  sourceProvider: BrainSourceProvider;
  sourceType: BrainSourceType;
};

export type BrainIngestHandlerInput<
  TItem extends NormalizedBrainSourceItem = NormalizedBrainSourceItem,
> = {
  jobId: string;
  userWorkosId: string;
  brainRef: string | null;
  // The integration the source item came through, when the source has one.
  // Lets handlers look up per-(brain, integration) source config live at
  // ingest time (e.g. Gmail ingestion instructions).
  integrationId: string | null;
  importRunId?: string | null;
  item: TItem;
  env: BrainAgentIngestEnv;
  signal?: AbortSignal;
};

export type BrainIngestHandler<
  TItem extends NormalizedBrainSourceItem = NormalizedBrainSourceItem,
> = {
  descriptor: BrainIngestJobDescriptor;
  isPayload(value: unknown): value is TItem;
  run(input: BrainIngestHandlerInput<TItem>): Promise<Record<string, unknown>>;
};

// Legacy deterministic template writer; kept registered so already-queued jobs
// drain. New Jamie webhooks enqueue the agentic kind below.
const JAMIE_MEETING_INGEST_DESCRIPTOR = {
  kind: "brain_source_item_ingest",
  sourceProvider: "jamie",
  sourceType: "meeting",
} as const satisfies BrainIngestJobDescriptor;

const JAMIE_MEETING_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "jamie",
  sourceType: "meeting",
} as const satisfies BrainIngestJobDescriptor;

const GRANOLA_MEETING_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "granola",
  sourceType: "meeting",
} as const satisfies BrainIngestJobDescriptor;

const FATHOM_MEETING_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "fathom",
  sourceType: "meeting",
} as const satisfies BrainIngestJobDescriptor;

const CHAT_CAPTURE_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "goat-chat",
  sourceType: "capture",
} as const satisfies BrainIngestJobDescriptor;

const POINTER_HYDRATE_DESCRIPTORS = [
  {
    kind: "brain_pointer_hydrate",
    sourceProvider: "slack",
    sourceType: "pointer",
  },
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
] as const satisfies readonly BrainIngestJobDescriptor[];

const UPLOAD_ASSET_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "upload",
  sourceType: "asset",
} as const satisfies BrainIngestJobDescriptor;

const SLACK_CONVERSATION_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "slack",
  sourceType: "conversation",
} as const satisfies BrainIngestJobDescriptor;

const LINEAR_ISSUE_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "linear",
  sourceType: "issue",
} as const satisfies BrainIngestJobDescriptor;

const GITHUB_ACTIVITY_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "github",
  sourceType: "activity",
} as const satisfies BrainIngestJobDescriptor;

const HUBSPOT_OBJECT_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "hubspot",
  sourceType: "activity",
} as const satisfies BrainIngestJobDescriptor;

const ATTIO_OBJECT_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "attio",
  sourceType: "activity",
} as const satisfies BrainIngestJobDescriptor;

const GMAIL_THREAD_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "gmail",
  sourceType: "thread",
} as const satisfies BrainIngestJobDescriptor;

const GOOGLE_DRIVE_DOCUMENT_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "google_drive",
  sourceType: "document",
} as const satisfies BrainIngestJobDescriptor;

const IMPORT_AGENT_INGEST_DESCRIPTOR = {
  kind: "brain_agent_ingest",
  sourceProvider: "goat-import",
  sourceType: "run",
} as const satisfies BrainIngestJobDescriptor;

const BRAIN_INGEST_HANDLERS: readonly BrainIngestHandler[] = [
  {
    descriptor: JAMIE_MEETING_INGEST_DESCRIPTOR,
    isPayload: isNormalizedJamieMeetingSourceItem,
    run: runTypedBrainIngestHandler(writeJamieMeetingToBrain),
  },
  {
    descriptor: JAMIE_MEETING_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedJamieMeetingSourceItem,
    run: runTypedBrainIngestHandler(runJamieMeetingAgentIngest),
  },
  {
    descriptor: GRANOLA_MEETING_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedGranolaMeetingSourceItem,
    run: runTypedBrainIngestHandler(runGranolaMeetingAgentIngest),
  },
  {
    descriptor: FATHOM_MEETING_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedFathomMeetingSourceItem,
    run: runTypedBrainIngestHandler(runFathomMeetingAgentIngest),
  },
  {
    descriptor: CHAT_CAPTURE_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedChatCaptureSourceItem,
    run: runTypedBrainIngestHandler(runChatCaptureAgentIngest),
  },
  ...POINTER_HYDRATE_DESCRIPTORS.map(
    (descriptor): BrainIngestHandler<NormalizedBrainPointerSourceItem> => ({
      descriptor,
      isPayload: isNormalizedBrainPointerSourceItem,
      run: runBrainPointerHydrate,
    }),
  ),
  {
    descriptor: UPLOAD_ASSET_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedUploadAssetSourceItem,
    run: runTypedBrainIngestHandler(runUploadAssetAgentIngest),
  },
  {
    descriptor: SLACK_CONVERSATION_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedSlackConversationSourceItem,
    run: runTypedBrainIngestHandler(runSlackConversationAgentIngest),
  },
  {
    descriptor: LINEAR_ISSUE_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedLinearIssueSourceItem,
    run: runTypedBrainIngestHandler(runLinearIssueAgentIngest),
  },
  {
    descriptor: GITHUB_ACTIVITY_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedGitHubActivitySourceItem,
    run: runTypedBrainIngestHandler(runGitHubActivityAgentIngest),
  },
  {
    descriptor: HUBSPOT_OBJECT_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedHubspotObjectSourceItem,
    run: runTypedBrainIngestHandler(runHubspotObjectAgentIngest),
  },
  {
    descriptor: ATTIO_OBJECT_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedAttioObjectSourceItem,
    run: runTypedBrainIngestHandler(runAttioObjectAgentIngest),
  },
  {
    descriptor: GMAIL_THREAD_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedGmailThreadSourceItem,
    run: runTypedBrainIngestHandler(runGmailThreadAgentIngest),
  },
  {
    descriptor: GOOGLE_DRIVE_DOCUMENT_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedGoogleDriveDocumentSourceItem,
    run: runTypedBrainIngestHandler(runGoogleDriveDocumentAgentIngest),
  },
  {
    descriptor: IMPORT_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedImportSourceItem,
    run: runTypedBrainIngestHandler(runImportAgentIngest),
  },
];

function runTypedBrainIngestHandler<TItem extends NormalizedBrainSourceItem>(
  run: (input: BrainIngestHandlerInput<TItem>) => Promise<Record<string, unknown>>,
): BrainIngestHandler["run"] {
  return (input) => run(input as BrainIngestHandlerInput<TItem>);
}

export type BrainIngestStore = {
  claimNext(input: {
    leaseId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
    supportedJobs: readonly BrainIngestJobDescriptor[];
  }): Promise<BrainIngestJobWithSource | null>;
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
    result?: Record<string, unknown>;
  }): Promise<boolean>;
};

export function createDbBrainIngestStore(): BrainIngestStore {
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
            -- A queued integration job is no longer runnable after its source
            -- is disabled or removed. The source action also terminally skips
            -- existing work; this guard closes the concurrent claim race.
            AND (
              job.kind = 'brain_pointer_hydrate'
              OR job.integration_id IS NULL
              OR job.brain_ref IS NULL
              OR EXISTS (
                SELECT 1
                FROM goat.brain_sources AS brain_source
                WHERE brain_source.brain_id = job.brain_ref
                  AND brain_source.integration_id = job.integration_id
                  AND brain_source.enabled = true
              )
            )
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
          RETURNING ${brainIngestJobColumnsSql}
        )
        SELECT
          claimed.*,
          source.source_type AS "sourceType",
          source.normalized_payload AS "normalizedPayload"
        FROM claimed
        INNER JOIN goat.brain_source_items AS source ON source.id = claimed."sourceItemId"
      `);
      return rowsFromExecute<BrainIngestJobWithSource>(result)[0] ?? null;
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
      const terminal = input.attempts >= (input.maxAttempts ?? BRAIN_INGEST_MAX_ATTEMPTS);
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
      const failureResultJson = JSON.stringify(input.result ?? {});
      const result = await getDb().execute(sql`
        WITH failed_job AS (
          UPDATE goat.brain_ingest_jobs
          SET status = ${terminal ? "failed" : "queued"},
              lease_id = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_run_at = ${nextRunAt},
              last_error = ${input.error},
              result = result || ${failureResultJson}::jsonb || jsonb_build_object(
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

let registeredBrainIngestWakeup: (() => void) | null = null;

export function setBrainIngestWakeup(wake: (() => void) | null) {
  registeredBrainIngestWakeup = wake;
}

export function wakeBrainIngestWorker() {
  registeredBrainIngestWakeup?.();
}

export async function claimNextBrainIngestJob(input: {
  leaseOwner: string;
  supportedJobs: readonly BrainIngestJobDescriptor[];
  store?: BrainIngestStore;
  leaseTtlMs?: number;
  releasePendingReservations?: boolean;
}) {
  const now = new Date();
  const leaseId = newBrainIngestLeaseId();
  const store = input.store ?? createDbBrainIngestStore();
  // The long-running worker creates one DB store and passes it into every
  // claim. Keep backlog release explicit so that test-store injection does not
  // accidentally disable the production sweep.
  if (input.releasePendingReservations ?? !input.store) {
    await releasePendingIngestionReservations({ now, maxWorkspaces: 50 });
  }
  return store.claimNext({
    leaseId,
    leaseOwner: input.leaseOwner,
    now,
    leaseExpiresAt: new Date(now.getTime() + (input.leaseTtlMs ?? BRAIN_INGEST_LEASE_TTL_MS)),
    supportedJobs: input.supportedJobs,
  });
}

export async function runClaimedBrainIngestJob(input: {
  job: BrainIngestJobWithSource;
  env: Pick<RunnerEnv, "jobLeaseTtlMs" | "vercelAiGatewayApiKey"> & {
    blobReadWriteToken?: RunnerEnv["blobReadWriteToken"];
    exaApiKey?: RunnerEnv["exaApiKey"];
    googleOAuthClientId?: RunnerEnv["googleOAuthClientId"];
    googleOAuthClientSecret?: RunnerEnv["googleOAuthClientSecret"];
  };
  handlers?: readonly BrainIngestHandler[];
  store?: BrainIngestStore;
}) {
  const runStartedAt = performance.now();
  const store = input.store ?? createDbBrainIngestStore();
  const handlers = input.handlers ?? BRAIN_INGEST_HANDLERS;
  const leaseId = requireJobLease(input.job, "leaseId");
  const leaseOwner = requireJobLease(input.job, "leaseOwner");
  const userIdHash = hashUserId(input.job.userWorkosId);
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
  } satisfies Attributes;
  const runSpan = startSpan(SPANS.brainIngestRun, baseAttributes);
  let leaseActive = true;
  let telemetryFinished = false;
  const runAbort = new AbortController();

  const loseLease = () => {
    if (!leaseActive) return;
    leaseActive = false;
    runAbort.abort(new Error("Goat Brain ingestion lease was revoked."));
  };

  const finishTelemetry = (
    outcome: "success" | "failure" | "aborted" | "skipped",
    attributes: Attributes = {},
    error?: unknown,
  ) => {
    if (telemetryFinished) return;
    telemetryFinished = true;
    const durationMs = Math.round(performance.now() - runStartedAt);
    const failureCategory =
      outcome === "failure" && error
        ? runSpan.fail(error, attributes)
        : (attributes["goat.failure_category"] as string | undefined);
    const finalAttributes: Attributes = {
      ...baseAttributes,
      "goat.outcome": outcome,
      ...(failureCategory ? { "goat.failure_category": failureCategory } : {}),
      ...attributes,
    };
    runSpan.end(finalAttributes);
    recordBrainIngestRun({
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
      budget_limit_usd_micros: finalAttributes["goat.budget_limit_usd_micros"],
      budget_stop_threshold_usd_micros: finalAttributes["goat.budget_stop_threshold_usd_micros"],
      model_cost_usd_micros: finalAttributes["goat.model_cost_usd_micros"],
      brain_query_cost_usd_micros: finalAttributes["goat.brain_query_cost_usd_micros"],
      web_search_cost_usd_micros: finalAttributes["goat.web_search_cost_usd_micros"],
      total_cost_usd_micros: finalAttributes["goat.total_cost_usd_micros"],
      budget_accounting_complete: finalAttributes["goat.budget_accounting_complete"],
      budget_exhausted: finalAttributes["goat.budget_exhausted"],
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
      leaseExpiresAt: new Date(now.getTime() + BRAIN_INGEST_LEASE_TTL_MS),
    });
    if (!active) loseLease();
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
      loseLease();
    });
  }, BRAIN_INGEST_HEARTBEAT_INTERVAL_MS);

  try {
    // Revalidate immediately before starting expensive work. Disable/remove
    // transitions revoke the lease, and the shared signal then stops the model
    // loop and CLI before its final Brain sync.
    await heartbeat();
    if (!leaseActive) {
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      return;
    }
    const handler = findBrainIngestHandler(handlers, input.job);
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
          name: SPANS.brainIngestRun,
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
            ...(input.job.importRunId ? { importRunId: input.job.importRunId } : {}),
            item: normalizedPayload,
            env: {
              vercelAiGatewayApiKey: input.env.vercelAiGatewayApiKey,
              blobReadWriteToken: input.env.blobReadWriteToken,
              ...(input.env.exaApiKey ? { exaApiKey: input.env.exaApiKey } : {}),
              ...(input.env.googleOAuthClientId
                ? { googleOAuthClientId: input.env.googleOAuthClientId }
                : {}),
              ...(input.env.googleOAuthClientSecret
                ? { googleOAuthClientSecret: input.env.googleOAuthClientSecret }
                : {}),
            },
            signal: runAbort.signal,
          }),
      ),
    );
    const resultWithDuration = withBrainIngestRunDuration(result, runStartedAt);
    recordBrainIngestModelCost(result);
    await debitIngestModelCost(input.job, result);
    if (!leaseActive) {
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      return;
    }
    if (isSkippedIngestResult(resultWithDuration)) {
      const skipped = await runSpan.runInContext(() =>
        withSpan(SPANS.brainIngestComplete, baseAttributes, () =>
          store.skip({
            id: input.job.id,
            sourceItemId: input.job.sourceItemId,
            leaseId,
            leaseOwner,
            now: new Date(),
            result: resultWithDuration,
            reason: skippedIngestReason(resultWithDuration),
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
        ...brainIngestBudgetAttributes(result),
      });
      return;
    }
    const completed = await runSpan.runInContext(() =>
      withSpan(SPANS.brainIngestComplete, baseAttributes, () =>
        store.complete({
          id: input.job.id,
          sourceItemId: input.job.sourceItemId,
          leaseId,
          leaseOwner,
          now: new Date(),
          result: resultWithDuration,
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
    if (input.job.kind !== "brain_pointer_hydrate" && input.job.workspaceId && input.job.brainRef) {
      await captureServerEvent(
        "brain_ingestion_completed",
        input.job.userWorkosId,
        {
          workspace_id: input.job.workspaceId,
          brain_id: input.job.brainRef,
          provider: input.job.sourceProvider,
          source_type: input.job.sourceType,
        },
        { workspaceId: input.job.workspaceId },
      );
    }
    finishTelemetry("success", {
      "goat.status": "succeeded",
      ...brainIngestBudgetAttributes(result),
    });
  } catch (error) {
    if (error instanceof BrainIngestBudgetError) {
      recordBrainIngestModelCost(error.result);
      // The agent ran and spent real provider money before the budget error;
      // frontier pass-through still charges it.
      await debitIngestModelCost(input.job, error.result);
    }
    if (!leaseActive) {
      finishTelemetry("aborted", {
        "goat.status": "running",
        "goat.failure_category": "lease_lost",
      });
      return;
    }
    const message = errorMessage(error);
    const maxAttempts =
      error instanceof BrainIngestBudgetError
        ? 1
        : error instanceof BrainAgentOutcomeError
          ? BRAIN_INGEST_OUTCOME_MAX_ATTEMPTS
          : BRAIN_INGEST_MAX_ATTEMPTS;
    const terminal = input.job.attempts >= maxAttempts;
    const failureResult =
      error instanceof BrainIngestBudgetError
        ? withBrainIngestRunDuration({ ...error.result }, runStartedAt)
        : undefined;
    const active = await runSpan.runInContext(() =>
      withSpan(SPANS.brainIngestFail, baseAttributes, () =>
        store.fail({
          id: input.job.id,
          sourceItemId: input.job.sourceItemId,
          leaseId,
          leaseOwner,
          now: new Date(),
          attempts: input.job.attempts,
          error: message,
          maxAttempts,
          ...(failureResult ? { result: failureResult } : {}),
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
        "goat.status": terminal ? "failed" : "queued",
        ...(error instanceof BrainIngestBudgetError
          ? brainIngestBudgetAttributes(error.result)
          : {}),
      },
      error,
    );
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    // Flush the job's spans promptly; the runner is long-lived and may not shut
    // down (its only other flush point) for a long time. No-ops when disabled.
    await flushBraintrust();
    await flushLatitude();
  }
}

function withBrainIngestRunDuration<T extends Record<string, unknown>>(
  result: T,
  runStartedAt: number,
) {
  return {
    ...result,
    durationMs: Math.max(0, Math.round(performance.now() - runStartedAt)),
  };
}

// Usage-based pass-through: debit the attempt's tracked provider cost (model
// plus brain-query and web-search tool spend, all recorded per attempt for
// every tier) from the workspace's credits.
// Priced from the recorded trace model, so a mid-queue tier toggle can never
// bill the wrong tier. Charged per attempt — the budget counters reset each
// attempt, so charging only completed jobs would eat retried attempts' real
// spend — with `ingest_model:{jobId}:{attempt}` as the replay guard. The flat
// per-item ingestion fee is charged separately, once per reservation, at
// admission time (see tryAdmitIngestion in @opencompany/db).
async function debitIngestModelCost(
  job: BrainIngestJobWithSource,
  result: Record<string, unknown>,
) {
  try {
    if (!job.workspaceId) return;
    const trace = normalizeBrainIngestTrace(result.trace);
    if (!trace) return;
    const budget = trace.budget;
    const modelCostUsdMicros = budget?.modelCostUsdMicros ?? 0;
    const providerCostUsdMicros =
      modelCostUsdMicros +
      (budget?.brainQueryCostUsdMicros ?? 0) +
      (budget?.webSearchCostUsdMicros ?? 0);
    if (!Number.isFinite(providerCostUsdMicros) || providerCostUsdMicros <= 0) {
      return;
    }
    const platformFeeUsdMicros = calculatePlatformFeeUsdMicros(providerCostUsdMicros);
    const debit = await recordCreditDebit({
      workspaceId: job.workspaceId,
      userWorkosId: job.userWorkosId,
      source: "ingest_model_usage",
      idempotencyKey: `ingest_model:${job.id}:${job.attempts}`,
      ingestJobId: job.id,
      providerCostUsdMicros,
      platformFeeUsdMicros,
      totalCostUsdMicros: providerCostUsdMicros + platformFeeUsdMicros,
      costBasis: {
        kind: "ingest_model_usage",
        model: trace.model,
        attempt: job.attempts,
        modelCostUsdMicros,
        brainQueryCostUsdMicros: budget?.brainQueryCostUsdMicros ?? 0,
        webSearchCostUsdMicros: budget?.webSearchCostUsdMicros ?? 0,
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
    });
    if (debit.ok) {
      await captureModelSpendRecorded({
        userWorkosId: job.userWorkosId,
        workspaceId: job.workspaceId,
        billingSource: "ingest_model_usage",
        surface: "brain_ingest",
        model: trace.model,
        providerCostUsdMicros,
        platformFeeUsdMicros,
        totalCostUsdMicros: providerCostUsdMicros + platformFeeUsdMicros,
        modelCostUsdMicros,
        ledgerId: debit.ledgerId,
        ingestJobId: job.id,
      });
    }
  } catch (error) {
    // A debit failure must never fail (or retry) the ingest job itself.
    logger.warn("Goat Brain ingest model debit failed", {
      event: "opencompany.goat_brain_ingest_debit_failed",
      job_id: job.id,
      workspace_id: job.workspaceId,
      error,
    });
  }
}

function recordBrainIngestModelCost(result: Record<string, unknown>) {
  const trace = normalizeBrainIngestTrace(result.trace);
  if (!trace) return;

  if (trace.triage) {
    recordBrainIngestModelUsageCost(trace.triage.model, trace.triage.usage);
  }
  // A triage skip has no second/full-agent model call; its top-level model and
  // usage mirror the triage fields for backwards-compatible activity views.
  if (trace.triage?.decision === "skip") return;
  recordBrainIngestModelUsageCost(trace.model, trace.usage);
}

function recordBrainIngestModelUsageCost(
  model: string,
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadInputTokens?: number | null;
    cacheWriteInputTokens?: number | null;
  },
) {
  const inputTokens = usage.inputTokens ?? 0;
  const inputCacheReadTokens = usage.cacheReadInputTokens ?? 0;
  const inputCacheWriteTokens = usage.cacheWriteInputTokens ?? 0;
  const cost = calculateModelUsageCost({
    modelName: model,
    inputTokens,
    inputNoCacheTokens: Math.max(inputTokens - inputCacheReadTokens - inputCacheWriteTokens, 0),
    inputCacheReadTokens,
    inputCacheWriteTokens,
    outputTokens: usage.outputTokens ?? 0,
  });

  recordModelCost({
    costUsdMicros: cost.totalCostUsdMicros,
    attributes: {
      "goat.model": model,
      "goat.surface": "brain_ingest",
    },
  });
}

export function startBrainIngestWorker(
  env: RunnerEnv,
  options: {
    store?: BrainIngestStore;
    concurrency?: number;
    pollIntervalMs?: number;
  } = {},
) {
  const store = options.store ?? createDbBrainIngestStore();
  const handlers = BRAIN_INGEST_HANDLERS;
  const supportedJobs = handlers.map((handler) => handler.descriptor);
  const concurrency = Math.max(1, options.concurrency ?? Math.min(2, env.workerConcurrency));
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? BRAIN_INGEST_POLL_INTERVAL_MS);
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
          const job = await claimNextBrainIngestJob({
            leaseOwner: env.instanceId,
            supportedJobs,
            store,
            leaseTtlMs: BRAIN_INGEST_LEASE_TTL_MS,
            releasePendingReservations: true,
          });
          if (!job) break;
          const running = runClaimedBrainIngestJob({
            job,
            env,
            handlers,
            store,
          })
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
        captureException(error, {
          event: "opencompany.goat_brain_ingest_worker_failed",
        });
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
  env: BrainAgentIngestEnv;
}) {
  const writes = buildJamieMeetingBrainWrites(input.item);
  const db = getDb();
  // Legacy jobs predate per-job brain refs; they land in the user's default
  // ("General") brain.
  const brainRef = input.brainRef ?? (await getDefaultBrainForUser(input.userWorkosId, { db }))?.id;
  if (!brainRef) {
    throw new Error(`No accessible Goat brain found for user ${input.userWorkosId}.`);
  }
  const existingRows = await listBrainFiles({ brainRef }, { db });
  const meetingAlreadyExists = existingRows.some((row) => row.brainId === writes.meetingBrainId);
  const evidence = await upsertBrainFile(
    {
      brainRef,
      userWorkosId: input.userWorkosId,
      path: brainFilePathFor(JAMIE_EVIDENCE_FOLDER, writes.evidenceBrainId),
      content: writes.evidenceContent,
    },
    { db },
  );
  const meeting = await upsertBrainFile(
    {
      brainRef,
      userWorkosId: input.userWorkosId,
      path: brainFilePathFor(JAMIE_MEETING_FOLDER, writes.meetingBrainId),
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

function requireJobLease(job: BrainIngestJobWithSource, field: "leaseId" | "leaseOwner") {
  const value = job[field];
  if (!value) throw new Error(`Claimed Goat Brain ingest job ${job.id} is missing ${field}.`);
  return value;
}

function nextRetryAt(now: Date, attempts: number) {
  const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delayMs);
}

function newBrainIngestLeaseId() {
  return `goat_brain_ingest_${randomUUID()}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Goat Brain ingest error.";
}

function brainIngestBudgetAttributes(result: Record<string, unknown>): Attributes {
  const budget = result.budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) return {};
  const record = budget as Record<string, unknown>;
  return {
    "goat.budget_limit_usd_micros": finiteNumber(record.limitUsdMicros),
    "goat.budget_stop_threshold_usd_micros": finiteNumber(record.stopThresholdUsdMicros),
    "goat.model_cost_usd_micros": finiteNumber(record.modelCostUsdMicros),
    "goat.brain_query_cost_usd_micros": finiteNumber(record.brainQueryCostUsdMicros),
    "goat.web_search_cost_usd_micros": finiteNumber(record.webSearchCostUsdMicros),
    "goat.total_cost_usd_micros": finiteNumber(record.totalCostUsdMicros),
    "goat.budget_accounting_complete": record.accountingComplete === true,
    "goat.budget_exhausted": record.exhausted === true,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    summary.trim() !== BRAIN_AGENT_SKIP_SENTINEL
  ) {
    return summary.trim();
  }
  return null;
}

function findBrainIngestHandler(
  handlers: readonly BrainIngestHandler[],
  job: Pick<BrainIngestJobWithSource, "kind" | "sourceProvider" | "sourceType">,
) {
  return handlers.find(
    (handler) =>
      handler.descriptor.kind === job.kind &&
      handler.descriptor.sourceProvider === job.sourceProvider &&
      handler.descriptor.sourceType === job.sourceType,
  );
}

function supportedJobDescriptorsWhere(descriptors: readonly BrainIngestJobDescriptor[]) {
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

const brainIngestJobColumnsSql = sql`
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
