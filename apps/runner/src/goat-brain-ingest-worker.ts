import { randomUUID } from "node:crypto";
import { goatBrainFilePathFor, upsertGoatBrainFile } from "@opencompany/db/goat-brain-files";
import {
  type GoatBrainIngestJob,
  type GoatBrainIngestJobKind,
  type GoatBrainSourceProvider,
  type GoatBrainSourceType,
} from "@opencompany/db/goat-schema";
import { getDefaultGoatBrainForUser } from "@opencompany/db/goat-workspaces";
import {
  isNormalizedGoatChatCaptureSourceItem,
  isNormalizedJamieMeetingSourceItem,
  isNormalizedSlackConversationSourceItem,
  isNormalizedUploadAssetSourceItem,
  type NormalizedBrainSourceItem,
  type NormalizedJamieMeetingSourceItem,
} from "@opencompany/goat-brain";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import {
  type GoatBrainAgentIngestEnv,
  runGoatChatCaptureAgentIngest,
  runJamieMeetingAgentIngest,
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

export const GOAT_BRAIN_INGEST_LEASE_TTL_MS = 5 * 60 * 1000;
export const GOAT_BRAIN_INGEST_HEARTBEAT_INTERVAL_MS = 5_000;
export const GOAT_BRAIN_INGEST_MAX_ATTEMPTS = 5;
const GOAT_BRAIN_INGEST_POLL_INTERVAL_MS = 5_000;

export type GoatBrainIngestJobWithSource = GoatBrainIngestJob & {
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
  userWorkosId: string;
  brainRef: string | null;
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

const GOAT_BRAIN_INGEST_HANDLERS: readonly GoatBrainIngestHandler[] = [
  {
    descriptor: JAMIE_MEETING_INGEST_DESCRIPTOR,
    isPayload: isNormalizedJamieMeetingSourceItem,
    run: writeJamieMeetingToBrain,
  },
  {
    descriptor: JAMIE_MEETING_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedJamieMeetingSourceItem,
    run: runJamieMeetingAgentIngest,
  },
  {
    descriptor: GOAT_CHAT_CAPTURE_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedGoatChatCaptureSourceItem,
    run: runGoatChatCaptureAgentIngest,
  },
  {
    descriptor: UPLOAD_ASSET_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedUploadAssetSourceItem,
    run: runUploadAssetAgentIngest,
  },
  {
    descriptor: SLACK_CONVERSATION_AGENT_INGEST_DESCRIPTOR,
    isPayload: isNormalizedSlackConversationSourceItem,
    run: runSlackConversationAgentIngest,
  },
];

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
          WHERE
            (
              (job.status = 'queued' AND job.next_run_at <= ${input.now})
              OR (job.status = 'running' AND job.lease_expires_at < ${input.now})
            )
            AND (${supportedJobsWhere})
          ORDER BY job.next_run_at ASC, job.created_at ASC
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
        ),
        claimed AS (
          UPDATE goat.brain_ingest_jobs AS job
          SET status = 'running',
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
              result = ${resultJson}::jsonb,
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

    async fail(input) {
      const terminal = input.attempts >= (input.maxAttempts ?? GOAT_BRAIN_INGEST_MAX_ATTEMPTS);
      const nextRunAt = terminal ? input.now : nextRetryAt(input.now, input.attempts);
      const result = await getDb().execute(sql`
        WITH failed_job AS (
          UPDATE goat.brain_ingest_jobs
          SET status = ${terminal ? "failed" : "queued"},
              lease_id = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_run_at = ${nextRunAt},
              last_error = ${input.error},
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
  return (input.store ?? createDbGoatBrainIngestStore()).claimNext({
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
  };
  handlers?: readonly GoatBrainIngestHandler[];
  store?: GoatBrainIngestStore;
}) {
  const store = input.store ?? createDbGoatBrainIngestStore();
  const handlers = input.handlers ?? GOAT_BRAIN_INGEST_HANDLERS;
  const leaseId = requireJobLease(input.job, "leaseId");
  const leaseOwner = requireJobLease(input.job, "leaseOwner");
  let leaseActive = true;

  const heartbeat = async () => {
    const now = new Date();
    const active = await store.heartbeat({
      id: input.job.id,
      leaseId,
      leaseOwner,
      now,
      leaseExpiresAt: new Date(now.getTime() + input.env.jobLeaseTtlMs),
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
    if (!handler.isPayload(input.job.normalizedPayload)) {
      throw new Error(
        `Goat Brain ingest job has an invalid ${input.job.sourceProvider}/${input.job.sourceType} normalized payload.`,
      );
    }
    if (input.job.normalizedPayload.contentHash !== input.job.contentHash) {
      throw new Error("Goat Brain ingest job content hash does not match its source payload.");
    }

    const result = await handler.run({
      userWorkosId: input.job.userWorkosId,
      brainRef: input.job.brainRef ?? null,
      item: input.job.normalizedPayload,
      env: {
        vercelAiGatewayApiKey: input.env.vercelAiGatewayApiKey,
        blobReadWriteToken: input.env.blobReadWriteToken,
      },
    });
    if (!leaseActive) return;
    await store.complete({
      id: input.job.id,
      sourceItemId: input.job.sourceItemId,
      leaseId,
      leaseOwner,
      now: new Date(),
      result,
    });
  } catch (error) {
    const message = errorMessage(error);
    await store.fail({
      id: input.job.id,
      sourceItemId: input.job.sourceItemId,
      leaseId,
      leaseOwner,
      now: new Date(),
      attempts: input.job.attempts,
      error: message,
    });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
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
            leaseTtlMs: env.jobLeaseTtlMs,
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
  job.brain_ref AS "brainRef",
  job.kind,
  job.content_hash AS "contentHash",
  job.status,
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
