import type { GoatBrainIngestJobRow, GoatBrainSourceItemRow } from "@/lib/task-collections";

export type GoatBrainActivityKind = "captured" | "filing" | "filed" | "retrying" | "failed";

export type GoatBrainActivityEvent = {
  id: string;
  kind: GoatBrainActivityKind;
  at: string;
  title: string;
  detail: string | null;
  sourceTitle: string;
  brainId: string | null;
};

export type GoatBrainDraftIngestStateKind = "queued" | "running" | "retrying" | "failed";

export type GoatBrainDraftIngestState = {
  kind: GoatBrainDraftIngestStateKind;
  jobId: string;
  title: string;
  detail: string | null;
  updatedAt: string;
  attempts: number;
};

const MAX_ACTIVITY_EVENTS = 50;
const MAX_DETAIL_LENGTH = 180;

// Flattens the ingest pipeline into a human activity feed: one event for the
// capture landing, plus one for the current state of its curation job.
export function buildGoatBrainActivityEvents(
  jobs: readonly GoatBrainIngestJobRow[],
  sourceItems: readonly GoatBrainSourceItemRow[],
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
      kind: "captured",
      at: item?.created_at ?? job.created_at,
      title: capturedTitle(provider),
      detail: null,
      sourceTitle,
      brainId: null,
    });

    if (job.status === "running") {
      events.push({
        id: `${job.id}:filing`,
        kind: "filing",
        at: job.updated_at,
        title: "Filing into brain…",
        detail: null,
        sourceTitle,
        brainId: null,
      });
    } else if (job.status === "succeeded") {
      events.push({
        id: `${job.id}:filed`,
        kind: "filed",
        at: job.completed_at ?? job.updated_at,
        title: "Filed into brain",
        detail: truncateDetail(firstLine(jobResultSummary(job))),
        sourceTitle,
        brainId,
      });
    } else if (job.status === "failed") {
      events.push({
        id: `${job.id}:failed`,
        kind: "failed",
        at: job.completed_at ?? job.updated_at,
        title: `Filing failed after ${job.attempts} ${job.attempts === 1 ? "attempt" : "attempts"}`,
        detail: truncateDetail(job.last_error),
        sourceTitle,
        brainId: null,
      });
    } else if (job.status === "queued" && job.attempts > 0) {
      events.push({
        id: `${job.id}:retrying`,
        kind: "retrying",
        at: job.updated_at,
        title: "Filing failed — will retry",
        detail: truncateDetail(job.last_error),
        sourceTitle,
        brainId: null,
      });
    }
  }

  return events
    .toSorted((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
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
    if (job.status === "succeeded") continue;

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
