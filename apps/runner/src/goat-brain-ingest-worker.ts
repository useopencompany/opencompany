import { createHash, randomUUID } from "node:crypto";
import {
  createGoatBrainMarkdownContent,
  goatBrainFilePathFor,
  MAX_GOAT_BRAIN_FILE_BYTES,
  upsertGoatBrainFileForUser,
} from "@opencompany/db/goat-brain-files";
import {
  type GoatBrainIngestJob,
  type GoatBrainIngestJobKind,
  type GoatBrainSourceProvider,
  type GoatBrainSourceType,
} from "@opencompany/db/goat-schema";
import {
  formatGoatBrainEvidenceLink,
  goatBrainTimelineEntryFromParts,
  isNormalizedJamieMeetingSourceItem,
  type NormalizedBrainSourceItem,
  type NormalizedJamieMeetingSourceItem,
  type NormalizedJamieMeetingTranscriptSegment,
  normalizeEvidenceId,
  normalizeGoatBrainId,
} from "@opencompany/goat-brain";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-brain-ingest" });

export const GOAT_BRAIN_INGEST_LEASE_TTL_MS = 5 * 60 * 1000;
export const GOAT_BRAIN_INGEST_HEARTBEAT_INTERVAL_MS = 5_000;
export const GOAT_BRAIN_INGEST_MAX_ATTEMPTS = 5;
const GOAT_BRAIN_INGEST_POLL_INTERVAL_MS = 5_000;
const JAMIE_TRANSCRIPT_EXCERPT_BYTES = 400_000;

export type GoatBrainIngestJobWithSource = GoatBrainIngestJob & {
  sourceType: GoatBrainSourceType;
  normalizedPayload: unknown;
};

export type GoatBrainIngestJobDescriptor = {
  kind: GoatBrainIngestJobKind;
  sourceProvider: GoatBrainSourceProvider;
  sourceType: GoatBrainSourceType;
};

export type GoatBrainIngestHandler<
  TItem extends NormalizedBrainSourceItem = NormalizedBrainSourceItem,
> = {
  descriptor: GoatBrainIngestJobDescriptor;
  isPayload(value: unknown): value is TItem;
  run(input: { userWorkosId: string; item: TItem }): Promise<Record<string, unknown>>;
};

const JAMIE_MEETING_INGEST_DESCRIPTOR = {
  kind: "brain_source_item_ingest",
  sourceProvider: "jamie",
  sourceType: "meeting",
} as const satisfies GoatBrainIngestJobDescriptor;

const GOAT_BRAIN_INGEST_HANDLERS: readonly GoatBrainIngestHandler[] = [
  {
    descriptor: JAMIE_MEETING_INGEST_DESCRIPTOR,
    isPayload: isNormalizedJamieMeetingSourceItem,
    run: writeJamieMeetingToBrain,
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
  env: Pick<RunnerEnv, "jobLeaseTtlMs">;
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
    if (input.job.kind !== "brain_source_item_ingest") {
      throw new Error(`Unsupported Goat Brain ingest job kind: ${input.job.kind}`);
    }
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
      item: input.job.normalizedPayload,
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
  item: NormalizedJamieMeetingSourceItem;
}) {
  const writes = buildJamieMeetingBrainWrites(input.item);
  const db = getDb();
  const evidence = await upsertGoatBrainFileForUser(
    {
      userWorkosId: input.userWorkosId,
      path: goatBrainFilePathFor("evidence/document", writes.evidenceBrainId),
      content: writes.evidenceContent,
    },
    { db },
  );
  const meeting = await upsertGoatBrainFileForUser(
    {
      userWorkosId: input.userWorkosId,
      path: goatBrainFilePathFor("meetings", writes.meetingBrainId),
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

export function buildJamieMeetingBrainWrites(item: NormalizedJamieMeetingSourceItem) {
  const meeting = item.content.meeting;
  const date = item.occurredAt.slice(0, 10);
  const titleSlug = (normalizeGoatBrainId(meeting.title) || "meeting").slice(0, 42);
  const meetingBrainId =
    normalizeGoatBrainId(`meeting-${date}-${titleSlug}-${shortHash(item.externalId)}`) ||
    `meeting-${shortHash(item.sourceRef)}`;
  const evidenceBrainId = normalizeEvidenceId(
    `ev-jamie-${shortHash(`${item.externalId}:${item.contentHash}`, 18)}`,
  );
  if (!evidenceBrainId) throw new Error("Could not derive Jamie evidence id.");

  const source = {
    ref: item.sourceRef,
    title: `Jamie: ${meeting.title}`,
    capturedAt: item.capturedAt,
  };
  const summaryMarkdown = truncateByBytes(meeting.summaryMarkdown, 120_000);
  const fullTranscript = formatTranscript(meeting.transcript);
  const fullEvidenceContent = createEvidenceContent({
    item,
    meetingBrainId,
    evidenceBrainId,
    source,
    summaryMarkdown,
    transcriptMarkdown: fullTranscript,
    truncatedTranscript: false,
  });
  const truncatedTranscript =
    Buffer.byteLength(fullEvidenceContent, "utf8") > MAX_GOAT_BRAIN_FILE_BYTES;
  const evidenceContent = truncatedTranscript
    ? createEvidenceContent({
        item,
        meetingBrainId,
        evidenceBrainId,
        source,
        summaryMarkdown,
        transcriptMarkdown: formatTranscriptExcerpt(
          meeting.transcript,
          JAMIE_TRANSCRIPT_EXCERPT_BYTES,
        ),
        truncatedTranscript: true,
      })
    : fullEvidenceContent;

  const evidenceLink = formatGoatBrainEvidenceLink(evidenceBrainId, "Jamie meeting notes");
  const meetingCompiledTruth = [
    "Imported from Jamie.",
    "## Summary",
    summaryMarkdown,
    "## Participants",
    formatParticipants(item),
    "## Action items",
    formatActionItems(item),
    "## Evidence",
    `- ${evidenceLink}`,
  ].join("\n\n");

  const meetingContent = createGoatBrainMarkdownContent({
    id: meetingBrainId,
    folderPath: "meetings",
    title: meeting.title,
    type: "meeting",
    status: "active",
    compiledTruth: meetingCompiledTruth,
    sources: [source],
    timeline: [
      goatBrainTimelineEntryFromParts({
        evidenceId: evidenceBrainId,
        at: item.occurredAt,
        summary: `Jamie notes imported for ${meeting.title}.`,
        detail: "Summary, action items, participants, and transcript were imported from Jamie.",
        sourceRef: item.sourceRef,
        sourceTitle: `Jamie: ${meeting.title}`,
      }),
    ],
  });

  if (Buffer.byteLength(evidenceContent, "utf8") > MAX_GOAT_BRAIN_FILE_BYTES) {
    throw new Error("Jamie evidence document exceeds the Goat Brain file size limit.");
  }
  if (Buffer.byteLength(meetingContent, "utf8") > MAX_GOAT_BRAIN_FILE_BYTES) {
    throw new Error("Jamie meeting document exceeds the Goat Brain file size limit.");
  }

  return {
    meetingBrainId,
    evidenceBrainId,
    meetingContent,
    evidenceContent,
    truncatedTranscript,
  };
}

function createEvidenceContent(input: {
  item: NormalizedJamieMeetingSourceItem;
  meetingBrainId: string;
  evidenceBrainId: string;
  source: { ref: string; title: string; capturedAt: string };
  summaryMarkdown: string;
  transcriptMarkdown: string;
  truncatedTranscript: boolean;
}) {
  const meeting = input.item.content.meeting;
  const compiledTruth = [
    "Jamie meeting notes.",
    "## Meeting metadata",
    [
      `- Started: ${meeting.startTime}`,
      meeting.endTime ? `- Ended: ${meeting.endTime}` : null,
      `- Source: ${input.item.sourceRef}`,
    ]
      .filter(Boolean)
      .join("\n"),
    "## Summary",
    input.summaryMarkdown,
    "## Participants",
    formatParticipants(input.item),
    "## Action items",
    formatActionItems(input.item),
    "## Transcript",
    input.truncatedTranscript
      ? [
          "The full raw Jamie payload is stored on the source item. This evidence record contains a bounded transcript excerpt because the transcript exceeded the Brain file size limit.",
          input.transcriptMarkdown,
        ].join("\n\n")
      : input.transcriptMarkdown,
  ].join("\n\n");

  return createGoatBrainMarkdownContent({
    id: input.evidenceBrainId,
    folderPath: "evidence/document",
    title: `Jamie notes: ${meeting.title}`,
    type: "evidence",
    evidenceKind: "document",
    status: "active",
    compiledTruth,
    related: [{ type: "about", to: input.meetingBrainId }],
    sources: [input.source],
  });
}

function formatParticipants(item: NormalizedJamieMeetingSourceItem) {
  const participants = item.content.meeting.participants;
  if (participants.length === 0) return "No participants listed by Jamie.";
  return participants
    .map((participant) => {
      const label =
        participant.name ?? participant.email ?? participant.id ?? "Unknown participant";
      const suffix = participant.email && participant.name ? ` (${participant.email})` : "";
      return `- ${label}${suffix}`;
    })
    .join("\n");
}

function formatActionItems(item: NormalizedJamieMeetingSourceItem) {
  const actionItems = item.content.meeting.actionItems;
  if (actionItems.length === 0) return "No action items listed by Jamie.";
  return actionItems
    .map((action) => `- ${action.text}${action.assignee ? ` (${action.assignee})` : ""}`)
    .join("\n");
}

function formatTranscript(segments: NormalizedJamieMeetingTranscriptSegment[]) {
  return segments.map(formatTranscriptSegment).join("\n");
}

function formatTranscriptExcerpt(
  segments: NormalizedJamieMeetingTranscriptSegment[],
  maxBytes: number,
) {
  const lines: string[] = [];
  let bytes = 0;
  for (const segment of segments) {
    const line = formatTranscriptSegment(segment);
    const nextBytes = bytes + Buffer.byteLength(`${line}\n`, "utf8");
    if (nextBytes > maxBytes) break;
    lines.push(line);
    bytes = nextBytes;
  }
  lines.push(
    `\nTranscript truncated after ${lines.length} of ${segments.length} Jamie transcript segments.`,
  );
  return lines.join("\n");
}

function formatTranscriptSegment(segment: NormalizedJamieMeetingTranscriptSegment) {
  const parts = [
    segment.startedAt ? `[${segment.startedAt}]` : null,
    segment.speaker ? `**${segment.speaker}:**` : null,
    segment.text,
  ].filter(Boolean);
  return `- ${parts.join(" ")}`;
}

function truncateByBytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  for (const char of value) {
    const next = `${output}${char}`;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    output = next;
  }
  return `${output}\n\n[Truncated to fit the Goat Brain file size limit.]`;
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

function shortHash(value: string, length = 10) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
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
