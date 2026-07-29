"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { toast } from "@opencompany/ui/components/sonner";
import { Archive, ArrowUpRight, ListTodo, Loader2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState, useTransition } from "react";
import { taskRowToView, useGoatAppData } from "@/components/GoatAppDataProvider";
import {
  formatGoatRelativeTime,
  GoatEmptyState,
  TasksWorkflowsDisabledRoute,
} from "@/components/GoatRoutes";
import type { GoatTaskView } from "@/components/GoatSurface";
import { formatUsdMicros } from "@/lib/cost-format";
import {
  formatGoatStartedAt,
  formatGoatTaskDuration,
  formatGoatTaskDurationMs,
  GOAT_STATUS_COPY,
  GOAT_TASK_BOARD_COLUMN_COPY,
  GOAT_TASK_BOARD_COLUMNS,
  GOAT_WORKFLOW_TASK_STATUS_DOT_CLASS,
  type GoatTaskBoardColumn,
  goatTaskBoardColumn,
  goatTaskBoardStatusCopy,
  goatWorkflowTaskDisplayStatus,
  toGoatTaskTitle,
} from "@/lib/task-display";
import { archiveGoatTaskAction } from "@/lib/tasks";
import { useGoatTaskSummary } from "@/lib/use-task-summary";

const TERMINAL_TASK_STATUSES = new Set<GoatTaskView["status"]>(["succeeded", "failed", "canceled"]);
const CAPPED_TASK_BOARD_COLUMNS = new Set<GoatTaskBoardColumn>(["done", "canceled"]);
export const GOAT_TASK_BOARD_COLUMN_CAP = 50;

export function GoatTasksBoardRoute({ workflowNames }: { workflowNames: Record<string, string> }) {
  const { featureFlags, taskRows, tasksReady } = useGoatAppData();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const { activeTasks, columns } = useMemo(() => {
    const liveTasks = taskRows.map(taskRowToView);
    const nonArchived = liveTasks
      .filter((task) => !task.archivedAt)
      .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const grouped: Record<GoatTaskBoardColumn, GoatTaskView[]> = {
      in_progress: [],
      in_review: [],
      done: [],
      canceled: [],
    };

    for (const task of nonArchived) {
      grouped[goatTaskBoardColumn(task)].push(task);
    }
    return { activeTasks: nonArchived, columns: grouped };
  }, [taskRows]);
  const selectedTask = selectedTaskId
    ? (activeTasks.find((task) => task.id === selectedTaskId) ?? null)
    : null;

  if (!featureFlags.taskSpawning) return <TasksWorkflowsDisabledRoute />;
  if (!tasksReady) return <GoatTasksBoardSkeleton />;

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-5 sm:px-6">
        <div className="flex w-full max-w-[1480px] flex-col gap-8 pb-24 pt-14 sm:pt-20">
          <header className="flex flex-col gap-1.5">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
              Tasks
            </h1>
            <p className="text-[13px] leading-5 text-ink-subtle">
              Background runs from workflows, schedules, and chat.
            </p>
          </header>

          {activeTasks.length === 0 ? (
            <GoatEmptyState
              icon={ListTodo}
              title="No tasks yet"
              description="Fire a workflow with # in chat, start an ad-hoc task, or set up a scheduled run — each run shows up here."
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              {GOAT_TASK_BOARD_COLUMNS.map((column) => (
                <TaskBoardColumn
                  key={column}
                  column={column}
                  tasks={columns[column]}
                  workflowNames={workflowNames}
                  onSelectTask={setSelectedTaskId}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedTask ? (
        <TaskBoardSheet
          key={selectedTask.id}
          task={selectedTask}
          workflowNames={workflowNames}
          onClose={() => setSelectedTaskId(null)}
        />
      ) : null}
    </main>
  );
}

export function GoatTasksBoardSkeleton() {
  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-5 sm:px-6">
        <div className="flex w-full max-w-[1480px] flex-col gap-8 pb-24 pt-14 sm:pt-20">
          <header className="flex flex-col gap-1.5">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
              Tasks
            </h1>
            <p className="text-[13px] leading-5 text-ink-subtle">
              Background runs from workflows, schedules, and chat.
            </p>
          </header>

          <div
            role="status"
            aria-label="Loading tasks"
            className="grid animate-pulse grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
          >
            {GOAT_TASK_BOARD_COLUMNS.map((column) => (
              <section key={column} className="flex min-w-0 flex-col gap-2.5">
                <div className="flex items-center justify-between px-1">
                  <div className="h-3 w-20 rounded bg-surface-muted" />
                  <div className="h-5 w-7 rounded-full bg-surface-muted" />
                </div>
                <div className="h-28 rounded-lg bg-surface-muted" />
                <div className="h-28 rounded-lg bg-surface-muted" />
              </section>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

function TaskBoardColumn({
  column,
  tasks,
  workflowNames,
  onSelectTask,
}: {
  column: GoatTaskBoardColumn;
  tasks: GoatTaskView[];
  workflowNames: Record<string, string>;
  onSelectTask: (taskId: string) => void;
}) {
  const label = GOAT_TASK_BOARD_COLUMN_COPY[column];
  const [expanded, setExpanded] = useState(false);
  const capped = CAPPED_TASK_BOARD_COLUMNS.has(column) && !expanded;
  const visibleTasks = capped ? tasks.slice(0, GOAT_TASK_BOARD_COLUMN_CAP) : tasks;
  const remaining = tasks.length - visibleTasks.length;

  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2.5">
      <header className="flex items-center justify-between px-1">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          {label}
        </h2>
        <span className="min-w-5 rounded-full bg-surface-muted px-1.5 py-0.5 text-center text-[10.5px] font-medium tabular-nums text-ink-subtle">
          {tasks.length}
        </span>
      </header>

      {tasks.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {visibleTasks.map((task) => (
            <li key={task.id}>
              <TaskBoardCard
                task={task}
                sourceLabel={taskSourceLabel(task, workflowNames)}
                onSelect={() => onSelectTask(task.id)}
              />
            </li>
          ))}
          {remaining > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="flex min-h-10 w-full items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-[11.5px] font-medium leading-5 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                Show {remaining} more
              </button>
            </li>
          ) : null}
        </ul>
      ) : (
        <div className="flex min-h-20 items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-[11.5px] leading-5 text-ink-faint">
          No {label.toLowerCase()} tasks
        </div>
      )}
    </section>
  );
}

function TaskBoardCard({
  task,
  sourceLabel,
  onSelect,
}: {
  task: GoatTaskView;
  sourceLabel: string;
  onSelect: () => void;
}) {
  const href = `/tasks/${encodeURIComponent(task.displayId)}`;
  return (
    <Link
      href={href}
      prefetch
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onSelect();
      }}
      aria-label={`Open ${toGoatTaskTitle(task.name)}`}
      className="group flex w-full items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-left transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <TaskStatusDot task={task} className="mt-[6px]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium leading-tight text-ink">
          {toGoatTaskTitle(task.name)}
        </span>
        <span className="mt-1 line-clamp-2 block text-[12px] leading-[1.45] text-ink-subtle">
          {task.outcomeComment?.trim() || goatTaskBoardStatusCopy(task)}
        </span>
        <span className="mt-2 flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] font-medium leading-4 text-ink-muted">
            {sourceLabel}
          </span>
          <span className="shrink-0 text-[10.5px] leading-4 text-ink-subtle">
            {formatGoatRelativeTime(task.updatedAt)}
          </span>
        </span>
      </span>
    </Link>
  );
}

function TaskBoardSheet({
  task,
  workflowNames,
  onClose,
}: {
  task: GoatTaskView;
  workflowNames: Record<string, string>;
  onClose: () => void;
}) {
  const { schedules } = useGoatAppData();
  const [isArchiving, startArchiveTransition] = useTransition();
  const schedule = task.scheduleId
    ? (schedules.find((candidate) => candidate.id === task.scheduleId) ?? null)
    : null;
  const terminal = TERMINAL_TASK_STATUSES.has(task.status);
  const { summary, error: summaryError } = useGoatTaskSummary(task.id, terminal);
  const workflowName = task.workflowId
    ? (workflowNames[task.workflowId] ?? `#${task.workflowId}`)
    : null;
  const durationLabel = !terminal
    ? null
    : summary?.durationMs !== null && summary?.durationMs !== undefined
      ? formatGoatTaskDurationMs(summary.durationMs)
      : summary
        ? formatGoatTaskDuration(task.createdAt, task.updatedAt)
        : null;
  const activityEntries = buildTaskActivityEntries({
    task,
    terminal,
    sourceLabel: taskSourceLabel(task, workflowNames),
    durationLabel,
  });

  const archiveTask = () => {
    if (!terminal) return;
    startArchiveTransition(async () => {
      const result = await archiveGoatTaskAction(task.id);
      if (!result.ok) {
        toast.error(result.error ?? `Could not archive "${task.name}".`);
        return;
      }
      onClose();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="left-auto right-0 top-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-y-0 border-r-0 bg-surface p-0 text-ink data-[ending-style]:translate-x-full data-[ending-style]:scale-100 data-[ending-style]:opacity-100 data-[starting-style]:translate-x-full data-[starting-style]:scale-100 data-[starting-style]:opacity-100 sm:w-[720px]">
        <header className="border-b border-border px-5 pb-4 pt-5 pr-12">
          <DialogTitle className="text-[17px] font-semibold leading-6 text-ink">
            {toGoatTaskTitle(task.name)}
          </DialogTitle>
          <DialogDescription className="mt-1 font-mono text-[11px] leading-4 text-ink-subtle">
            {task.displayId}
          </DialogDescription>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-5">
            <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-muted">
              {task.prompt}
            </p>

            {workflowName && !task.scheduleId ? (
              <p className="mt-3 text-[12px] leading-5 text-ink-subtle">
                From workflow <span className="text-ink-muted">{workflowName}</span>
              </p>
            ) : null}

            {task.scheduleId ? (
              <section className="mt-4 flex flex-col gap-2">
                <DetailLabel>Schedule</DetailLabel>
                <div className="rounded-lg border border-border bg-canvas px-3 py-2.5">
                  <div className="text-[12.5px] font-medium leading-5 text-ink">
                    {schedule?.name ?? "Scheduled routine"}
                  </div>
                  {schedule ? (
                    <div className="mt-0.5 font-mono text-[10.5px] leading-4 text-ink-subtle">
                      {schedule.cron} · {schedule.timezone}
                    </div>
                  ) : null}
                  {task.scheduledFor ? (
                    <div className="mt-1 text-[11.5px] leading-4 text-ink-subtle">
                      Scheduled for {formatGoatStartedAt(task.scheduledFor)}
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            <section className="mt-6 flex flex-col gap-3">
              <DetailLabel>Activity</DetailLabel>
              <ol className="flex flex-col">
                {activityEntries.map((entry, index) => (
                  <li key={entry.id} className="relative flex gap-3 pb-5 last:pb-0">
                    {index < activityEntries.length - 1 ? (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-0 left-[2.5px] top-3 w-px bg-border"
                      />
                    ) : null}
                    <span
                      aria-hidden="true"
                      className={`relative z-10 mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                        entry.tone === "danger" ? "bg-danger" : "bg-ink/30"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-1.5 text-[12.5px] leading-5">
                        <span
                          className={`font-medium ${entry.tone === "danger" ? "text-danger" : "text-ink"}`}
                        >
                          {entry.label}
                        </span>
                        {entry.meta ? (
                          <>
                            <span aria-hidden="true" className="text-ink-subtle">
                              ·
                            </span>
                            <span className="text-ink-subtle">{entry.meta}</span>
                          </>
                        ) : null}
                        <span aria-hidden="true" className="text-ink-subtle">
                          ·
                        </span>
                        <span className="text-ink-subtle">
                          {formatGoatStartedAt(entry.timestamp)}
                        </span>
                      </div>
                      {entry.body ? (
                        <div
                          className={`mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-[12px] leading-5 ${
                            entry.tone === "danger"
                              ? "border-danger-border bg-danger-bg text-danger"
                              : "border-border bg-canvas text-ink-muted"
                          }`}
                        >
                          {entry.body}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <aside className="w-[220px] shrink-0 overflow-y-auto border-l border-border px-4 py-5">
            <DetailLabel>Properties</DetailLabel>
            <div className="mt-3 flex flex-col gap-4">
              <PropertyRow label="Status">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2 py-1 text-[11.5px] font-medium text-ink">
                  <TaskStatusDot task={task} />
                  {GOAT_STATUS_COPY[task.status]}
                </span>
                {task.reportedOutcome === "needs_attention" ? (
                  <span className="mt-1.5 inline-flex w-fit rounded-full bg-warning-bg px-2 py-0.5 text-[10.5px] font-medium text-warning">
                    Needs attention
                  </span>
                ) : null}
              </PropertyRow>

              <PropertyRow label="Task run">
                <Link
                  href={`/tasks/${encodeURIComponent(task.displayId)}/run`}
                  prefetch
                  className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:text-ink-muted"
                >
                  View run
                  <ArrowUpRight size={12} strokeWidth={1.75} />
                </Link>
              </PropertyRow>

              <PropertyRow label="Cost">
                <span className="text-[12.5px] font-medium tabular-nums text-ink">
                  {summaryError
                    ? "Failed to load"
                    : summary?.cost.hasRecordedCosts
                      ? formatUsdMicros(summary.cost.totalCostUsdMicros)
                      : "—"}
                </span>
              </PropertyRow>
            </div>
          </aside>
        </div>

        <footer className="mt-auto flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={archiveTask}
            disabled={!terminal || isArchiving}
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isArchiving ? (
              <Loader2 size={13} strokeWidth={1.75} className="animate-spin" />
            ) : (
              <Archive size={13} strokeWidth={1.75} />
            )}
            Archive
          </button>
          <Link
            href={`/tasks/${encodeURIComponent(task.displayId)}`}
            prefetch
            className="inline-flex h-9 items-center rounded-md border border-ink bg-ink px-3.5 text-[12.5px] font-medium text-canvas transition-colors duration-150 hover:bg-ink/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            Open full view
          </Link>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function DetailLabel({ children }: { children: string }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
      {children}
    </h3>
  );
}

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="text-[11px] text-ink-subtle">{label}</span>
      {children}
    </div>
  );
}

type TaskActivityEntry = {
  id: string;
  label: string;
  tone?: "default" | "danger";
  timestamp: string;
  meta?: string | undefined;
  body?: string | undefined;
};

function buildTaskActivityEntries({
  task,
  terminal,
  sourceLabel,
  durationLabel,
}: {
  task: GoatTaskView;
  terminal: boolean;
  sourceLabel: string;
  durationLabel: string | null;
}): TaskActivityEntry[] {
  const entries: TaskActivityEntry[] = [
    { id: "created", label: "Created", meta: sourceLabel, timestamp: task.createdAt },
  ];

  if (!terminal) {
    if (task.updatedAt !== task.createdAt) {
      entries.push({
        id: "status",
        label: GOAT_STATUS_COPY[task.status],
        timestamp: task.updatedAt,
      });
    }
    return entries;
  }

  if (task.status === "succeeded") {
    entries.push({
      id: "completed",
      label:
        task.reportedOutcome === "needs_attention" ? "Completed — needs attention" : "Completed",
      timestamp: task.updatedAt,
      meta: durationLabel ?? undefined,
      body: task.result?.trim() || undefined,
    });
  } else if (task.status === "failed") {
    entries.push({
      id: "failed",
      label: "Failed",
      tone: "danger",
      timestamp: task.updatedAt,
      meta: durationLabel ?? undefined,
      body: task.error?.trim() || undefined,
    });
  } else if (task.status === "canceled") {
    entries.push({
      id: "canceled",
      label: "Canceled",
      timestamp: task.updatedAt,
      meta: durationLabel ?? undefined,
      body: task.error?.trim() || undefined,
    });
  }

  if (task.outcomeComment?.trim()) {
    entries.push({
      id: "note",
      label: "Note",
      timestamp: task.updatedAt,
      body: task.outcomeComment.trim(),
    });
  }

  return entries;
}

function TaskStatusDot({ task, className = "" }: { task: GoatTaskView; className?: string }) {
  const dotClass = GOAT_WORKFLOW_TASK_STATUS_DOT_CLASS[goatWorkflowTaskDisplayStatus(task)];
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass} ${className}`}
    />
  );
}

function taskSourceLabel(task: GoatTaskView, workflowNames: Record<string, string>): string {
  if (task.workflowId) return workflowNames[task.workflowId] ?? `#${task.workflowId}`;
  if (task.scheduleId) return "Scheduled";
  return "Ad-hoc";
}
