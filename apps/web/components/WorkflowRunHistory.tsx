"use client";

import { isSettledTaskStatus } from "@opencompany/core/tasks";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { formatRelativeTime } from "@/components/Routes";
import type { TaskView } from "@/components/Surface";
import {
  formatStartedAt,
  formatTaskDuration,
  taskBoardStatusCopy,
  toTaskTitle,
  WORKFLOW_TASK_STATUS_DOT_CLASS,
  workflowTaskDisplayStatus,
} from "@/lib/task-display";

// Runs reveal a page at a time. A workflow on a tight schedule accumulates hundreds of Tasks, and
// the first screen only has to answer "did the recent runs work?"; the Tasks board owns the rest.
const RUN_HISTORY_PAGE_SIZE = 8;
const RUN_HISTORY_SKELETON_ROWS = 3;

/**
 * Past runs of one workflow, newest first. Every run is a Task whose `workflowId` holds the
 * workflow slug, so this reads the live Task collection the rest of the app already subscribes to
 * rather than fetching its own history.
 */
export function WorkflowRunHistory({ workflowSlug }: { workflowSlug: string }) {
  const { tasks, tasksReady } = useAppData();
  const [visibleCount, setVisibleCount] = useState(RUN_HISTORY_PAGE_SIZE);
  // Ordered by start time, not last update: a run that finished long after a later one started
  // still belongs where it fired, which is how the schedule that produced it reads.
  const runs = useMemo(
    () =>
      tasks
        .filter((task) => task.workflowId === workflowSlug)
        .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [tasks, workflowSlug],
  );
  const visibleRuns = runs.slice(0, visibleCount);
  const remaining = runs.length - visibleRuns.length;
  // The server snapshot carries no Tasks, so the first paint has nothing to show. Keep the
  // skeleton until live rows arrive, otherwise a workflow with history flashes "No runs yet".
  const loading = !tasksReady && runs.length === 0;

  return (
    <section aria-labelledby="workflow-run-history-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="workflow-run-history-heading"
          className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle"
        >
          Run history
        </h2>
        {runs.length > 0 ? (
          <Link
            href={`/tasks?workflow=${encodeURIComponent(workflowSlug)}`}
            prefetch
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            All runs
            <ArrowUpRight size={13} strokeWidth={1.9} />
          </Link>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {loading ? (
          <RunHistorySkeleton />
        ) : runs.length === 0 ? (
          <p className="px-4 py-4 text-[13px] leading-5 text-ink-subtle">
            No runs yet. Hit Test to try this workflow, or fire it with{" "}
            <span className="font-medium text-ink">#</span> in chat.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {visibleRuns.map((run) => (
              <li key={run.id}>
                <WorkflowRunRow run={run} />
              </li>
            ))}
          </ul>
        )}
        {remaining > 0 ? (
          <div className="border-t border-border px-3 py-2.5">
            <button
              type="button"
              onClick={() => setVisibleCount((current) => current + RUN_HISTORY_PAGE_SIZE)}
              className="inline-flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              Show {Math.min(remaining, RUN_HISTORY_PAGE_SIZE)} more
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function WorkflowRunRow({ run }: { run: TaskView }) {
  const dotClass = WORKFLOW_TASK_STATUS_DOT_CLASS[workflowTaskDisplayStatus(run)];
  const startedAt = formatStartedAt(run.createdAt);

  return (
    <Link
      href={`/tasks/${encodeURIComponent(run.displayId)}`}
      prefetch
      aria-label={`Open run ${toTaskTitle(run.name)}, started ${startedAt}`}
      className="flex min-w-0 items-start gap-3 px-4 py-3 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <span aria-hidden="true" className={`mt-[7px] size-1.5 shrink-0 rounded-full ${dotClass}`} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium leading-tight text-ink">
            {toTaskTitle(run.name)}
          </span>
          {run.scheduledFor ? (
            <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] font-medium leading-4 text-ink-muted">
              Scheduled
            </span>
          ) : null}
        </span>
        <span className="line-clamp-2 text-[12px] leading-[1.45] text-ink-subtle">
          {runSummary(run)}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] leading-4 text-ink-subtle">
        <span title={startedAt}>{formatRelativeTime(run.createdAt)}</span>
        {isSettledTaskStatus(run.status) ? (
          <span className="tabular-nums">{formatTaskDuration(run.createdAt, run.updatedAt)}</span>
        ) : null}
      </span>
    </Link>
  );
}

// What the run left behind, in the order it is worth reading: the agent's own note, then the
// failure it hit, then the plain status so the line is never blank.
function runSummary(run: TaskView): string {
  return run.outcomeComment?.trim() || run.error?.trim() || taskBoardStatusCopy(run);
}

function RunHistorySkeleton() {
  return (
    <ul aria-hidden="true" className="flex flex-col divide-y divide-border">
      {Array.from({ length: RUN_HISTORY_SKELETON_ROWS }, (_, index) => (
        <li key={index} className="flex items-start gap-3 px-4 py-3">
          <span className="mt-[7px] size-1.5 shrink-0 animate-pulse rounded-full bg-surface-muted" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3 w-40 animate-pulse rounded bg-surface-muted" />
            <span className="h-3 w-64 max-w-full animate-pulse rounded bg-surface-muted" />
          </span>
        </li>
      ))}
    </ul>
  );
}
