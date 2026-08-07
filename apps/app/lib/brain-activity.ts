import {
  type GoatBrainIngestTrace,
  normalizeGoatBrainIngestTrace,
} from "@opencompany/db/brain-ingest-trace";
import type { GoatBrainIngestJobRow, GoatBrainSourceItemRow } from "@/lib/task-collections";

export type GoatBrainActivityKind =
  | "captured"
  | "filing"
  | "filed"
  | "paused"
  | "retrying"
  | "failed"
  | "skipped";

export type GoatBrainActivityPageAction = "created" | "updated" | "conflict_created";

export type GoatBrainActivityPage = {
  brainId: string;
  folderPath: string;
  title: string;
  action: GoatBrainActivityPageAction;
};

export type GoatBrainActivityEvent = {
  id: string;
  traceId: string;
  kind: GoatBrainActivityKind;
  at: string;
  title: string;
  detail: string | null;
  sourceTitle: string;
  brainId: string | null;
  pages: GoatBrainActivityPage[];
  trace: GoatBrainIngestTrace | null;
  durationMs: number | null;
};

type GoatBrainActivityEventOptions = {
  kinds?: readonly GoatBrainActivityKind[];
};

export type GoatBrainDraftIngestStateKind = "queued" | "paused" | "running" | "retrying" | "failed";

export type GoatBrainDraftIngestState = {
  kind: GoatBrainDraftIngestStateKind;
  jobId: string;
  title: string;
  detail: string | null;
  updatedAt: string;
  attempts: number;
};

const MAX_ACTIVITY_EVENTS = 50;
const MAX_ACTIVITY_EVENT_PAGES = 20;
const MAX_DETAIL_LENGTH = 180;

// Flattens the ingest pipeline into a human activity feed: one event for the
// capture landing, plus one for the current state of its curation job.
export function buildGoatBrainActivityEvents(
  jobs: readonly GoatBrainIngestJobRow[],
  sourceItems: readonly GoatBrainSourceItemRow[],
  options: GoatBrainActivityEventOptions = {},
): GoatBrainActivityEvent[] {
  const itemsById = new Map(sourceItems.map((item) => [item.id, item]));
  const events: GoatBrainActivityEvent[] = [];

  for (const job of jobs) {
    const item = itemsById.get(job.source_item_id) ?? null;
    const sourceTitle = item?.title?.trim() || "Untitled";
    const provider = item?.source_provider ?? job.source_provider;
    const brainId = jobResultBrainId(job);

    events.push({
      id: `${job.id}:captured`,
      traceId: job.id,
      kind: "captured",
      at: item?.created_at ?? job.created_at,
      title: capturedTitle(provider),
      detail: null,
      sourceTitle,
      brainId: null,
      pages: [],
      trace: null,
      durationMs: null,
    });

    if (job.status === "running") {
      events.push({
        id: `${job.id}:filing`,
        traceId: job.id,
        kind: "filing",
        at: job.updated_at,
        title: "Filing into brain…",
        detail: null,
        sourceTitle,
        brainId: null,
        pages: [],
        trace: null,
        durationMs: null,
      });
    } else if (job.status === "succeeded" || job.status === "skipped") {
      const skipped = jobResultSkipped(job);
      events.push({
        id: skipped ? `${job.id}:skipped` : `${job.id}:filed`,
        traceId: job.id,
        kind: skipped ? "skipped" : "filed",
        at: job.completed_at ?? job.updated_at,
        title: skipped ? "Skipped filing" : "Filed into brain",
        detail: truncateDetail(firstLine(jobResultSummary(job) ?? job.last_error)),
        sourceTitle,
        brainId,
        pages: jobResultPages(job),
        trace: jobResultTrace(job),
        durationMs: jobRunDurationMs(job),
      });
    } else if (job.status === "failed") {
      events.push({
        id: `${job.id}:failed`,
        traceId: job.id,
        kind: "failed",
        at: job.completed_at ?? job.updated_at,
        title: `Filing failed after ${job.attempts} ${job.attempts === 1 ? "attempt" : "attempts"}`,
        detail: truncateDetail(job.last_error),
        sourceTitle,
        brainId: null,
        pages: [],
        trace: null,
        durationMs: jobRunDurationMs(job),
      });
    } else if (job.status === "queued" && job.plan_paused) {
      events.push({
        id: `${job.id}:paused`,
        traceId: job.id,
        kind: "paused",
        at: job.updated_at,
        title: "Paused by plan",
        detail: "This ingestion will resume automatically when allowance becomes available.",
        sourceTitle,
        brainId: null,
        pages: [],
        trace: null,
        durationMs: null,
      });
    } else if (job.status === "queued" && job.attempts > 0) {
      events.push({
        id: `${job.id}:retrying`,
        traceId: job.id,
        kind: "retrying",
        at: job.updated_at,
        title: "Filing failed — will retry",
        detail: truncateDetail(job.last_error),
        sourceTitle,
        brainId: null,
        pages: [],
        trace: null,
        durationMs: null,
      });
    }
  }

  const includedKinds = options.kinds ? new Set(options.kinds) : null;
  return events
    .toSorted((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .filter((event) => !includedKinds || includedKinds.has(event.kind))
    .slice(0, MAX_ACTIVITY_EVENTS);
}

export function buildGoatBrainDraftIngestStates(
  jobs: readonly GoatBrainIngestJobRow[],
  sourceItems: readonly GoatBrainSourceItemRow[],
): ReadonlyMap<string, GoatBrainDraftIngestState> {
  const captureItemsById = new Map(
    sourceItems
      .filter((item) => item.source_provider === "goat-chat" && item.source_type === "capture")
      .map((item) => [item.id, item]),
  );
  const states = new Map<string, GoatBrainDraftIngestState>();

  for (const job of jobs) {
    if (job.kind !== "brain_agent_ingest" || job.source_provider !== "goat-chat") continue;
    if (job.status === "succeeded" || job.status === "skipped") continue;

    const item = captureItemsById.get(job.source_item_id);
    if (!item) continue;
    const draftBrainId = item.external_id.trim();
    if (!draftBrainId) continue;

    const state = draftIngestStateForJob(job, item);
    const current = states.get(draftBrainId);
    if (!current || new Date(state.updatedAt).getTime() > new Date(current.updatedAt).getTime()) {
      states.set(draftBrainId, state);
    }
  }

  return states;
}

function capturedTitle(provider: string) {
  if (provider === "goat-chat") return "Captured to inbox";
  if (provider === "jamie") return "Meeting received";
  return "Received";
}

function draftIngestStateForJob(
  job: GoatBrainIngestJobRow,
  item: GoatBrainSourceItemRow,
): GoatBrainDraftIngestState {
  const title = item.title?.trim() || "Untitled";
  if (job.status === "failed") {
    return {
      kind: "failed",
      jobId: job.id,
      title,
      detail: truncateDetail(job.last_error ?? item.last_ingest_error),
      updatedAt: job.completed_at ?? job.updated_at,
      attempts: job.attempts,
    };
  }
  if (job.status === "running") {
    return {
      kind: "running",
      jobId: job.id,
      title,
      detail: null,
      updatedAt: job.updated_at,
      attempts: job.attempts,
    };
  }
  if (job.plan_paused) {
    return {
      kind: "paused",
      jobId: job.id,
      title,
      detail: "Paused by plan",
      updatedAt: job.updated_at,
      attempts: job.attempts,
    };
  }
  return {
    kind: job.attempts > 0 ? "retrying" : "queued",
    jobId: job.id,
    title,
    detail: job.attempts > 0 ? truncateDetail(job.last_error ?? item.last_ingest_error) : null,
    updatedAt: job.updated_at,
    attempts: job.attempts,
  };
}

function jobResultSummary(job: GoatBrainIngestJobRow): string | null {
  const summary = job.result?.summary;
  return typeof summary === "string" && summary.trim() ? summary : null;
}

function jobResultBrainId(job: GoatBrainIngestJobRow): string | null {
  // Capture jobs report draftBrainId; meeting jobs report meetingBrainId.
  const value = job.result?.draftBrainId ?? job.result?.meetingBrainId;
  return typeof value === "string" && value.trim() ? value : null;
}

function jobResultSkipped(job: GoatBrainIngestJobRow): boolean {
  return job.status === "skipped" || job.result?.skipped === true;
}

function jobResultTrace(job: GoatBrainIngestJobRow): GoatBrainIngestTrace | null {
  return normalizeGoatBrainIngestTrace(job.result?.trace);
}

function jobRunDurationMs(job: GoatBrainIngestJobRow): number | null {
  const durationMs = finiteNonNegativeNumber(job.result?.durationMs);
  if (durationMs !== null) return Math.round(durationMs);

  if (!job.completed_at) return null;
  const startedAt = new Date(job.created_at).getTime();
  const completedAt = new Date(job.completed_at).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    return null;
  }
  return Math.round(completedAt - startedAt);
}

function jobResultPages(job: GoatBrainIngestJobRow): GoatBrainActivityPage[] {
  const value = job.result?.pages;
  if (!Array.isArray(value)) return [];

  const pages: GoatBrainActivityPage[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const page = parseActivityPage(item);
    if (!page) continue;
    const key = `${page.folderPath}/${page.brainId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push(page);
    if (pages.length >= MAX_ACTIVITY_EVENT_PAGES) break;
  }
  return pages;
}

function parseActivityPage(value: unknown): GoatBrainActivityPage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const brainId = normalizedText(record.brainId);
  const folderPath = normalizedText(record.folderPath);
  const action = normalizedActivityPageAction(record.action);
  if (!brainId || !folderPath || !action) return null;
  return {
    brainId,
    folderPath,
    title: normalizedText(record.title) || brainId,
    action,
  };
}

function normalizedActivityPageAction(value: unknown): GoatBrainActivityPageAction | null {
  if (value === "created" || value === "updated" || value === "conflict_created") return value;
  return null;
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNonNegativeNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function firstLine(value: string | null): string | null {
  if (!value) return null;
  const line = value
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return line ?? null;
}

function truncateDetail(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= MAX_DETAIL_LENGTH) return value;
  return `${value.slice(0, MAX_DETAIL_LENGTH)}…`;
}
