"use client";

import type { TaskViewMode } from "@opencompany/db/schema";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@opencompany/ui/components/select";
import { toast } from "@opencompany/ui/components/sonner";
import { GitHubIcon } from "@opencompany/ui/icons";
import { Archive, ArrowUpRight, LayoutGrid, ListTodo, Loader2, Rows3 } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, type ReactNode, useMemo, useState, useTransition } from "react";
import { taskRowToView, useAppData } from "@/components/AppDataProvider";
import {
  EmptyState,
  formatRelativeTime,
  TasksWorkflowsDisabledRoute,
} from "@/components/AppRoutes";
import type { TaskView } from "@/components/ChatSurface";
import { formatUsdMicros } from "@/lib/cost-format";
import { extractGitHubPullRequestUrl } from "@/lib/pull-request-link";
import {
  formatStartedAt,
  formatTaskDuration,
  formatTaskDurationMs,
  STATUS_COPY,
  TASK_BOARD_COLUMN_COPY,
  TASK_BOARD_COLUMNS,
  type TaskBoardColumn,
  taskBoardColumn,
  taskBoardStatusCopy,
  toTaskTitle,
  WORKFLOW_TASK_STATUS_DOT_CLASS,
  workflowTaskDisplayStatus,
} from "@/lib/task-display";
import { archiveTaskAction } from "@/lib/tasks";
import { useTaskSummary } from "@/lib/use-task-summary";
import { updateTaskViewModeAction } from "@/lib/user-preferences";

const TERMINAL_TASK_STATUSES = new Set<TaskView["status"]>(["succeeded", "failed", "canceled"]);
const CAPPED_TASK_BOARD_COLUMNS = new Set<TaskBoardColumn>(["done", "canceled"]);
export const TASK_BOARD_COLUMN_CAP = 50;

type TaskTimeRange = "7d" | "30d" | "90d" | "all";

const TASK_TIME_RANGE_OPTIONS = [
  "7d",
  "30d",
  "90d",
  "all",
] as const satisfies readonly TaskTimeRange[];

const TASK_TIME_RANGE_LABELS: Record<TaskTimeRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

const TASK_TIME_RANGE_MS: Record<Exclude<TaskTimeRange, "all">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

function isTaskTimeRange(value: unknown): value is TaskTimeRange {
  return TASK_TIME_RANGE_OPTIONS.some((option) => option === value);
}

export function TasksBoardRoute({
  workflowNames,
  initialViewMode = "board",
}: {
  workflowNames: Record<string, string>;
  initialViewMode?: TaskViewMode;
}) {
  const { featureFlags, taskRows, tasksReady } = useAppData();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TaskTimeRange>("7d");
  const [viewMode, setViewModeState] = useState<TaskViewMode>(initialViewMode);
  const [, startViewModeTransition] = useTransition();
  const [nowMs] = useState(() => Date.now());

  function setViewMode(mode: TaskViewMode) {
    if (mode === viewMode) return;
    const previous = viewMode;
    setViewModeState(mode);
    startViewModeTransition(async () => {
      const result = await updateTaskViewModeAction(mode);
      if (!result.ok) {
        setViewModeState(previous);
        toast.error("Could not save your view preference.");
      }
    });
  }
  const { activeTasks, columns } = useMemo(() => {
    const liveTasks = taskRows.map(taskRowToView);
    const nonArchived = liveTasks
      .filter((task) => !task.archivedAt)
      .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const cutoffMs = timeRange === "all" ? null : nowMs - TASK_TIME_RANGE_MS[timeRange];
    const grouped: Record<TaskBoardColumn, TaskView[]> = {
      in_progress: [],
      in_review: [],
      done: [],
      canceled: [],
    };

    for (const task of nonArchived) {
      const column = taskBoardColumn(task);
      // Only the terminal columns are date-filtered so a stalled in-progress
      // or in-review task never disappears just because it's old.
      if (cutoffMs !== null && CAPPED_TASK_BOARD_COLUMNS.has(column)) {
        const updatedMs = new Date(task.updatedAt).getTime();
        if (Number.isFinite(updatedMs) && updatedMs < cutoffMs) continue;
      }
      grouped[column].push(task);
    }
    return { activeTasks: nonArchived, columns: grouped };
  }, [taskRows, timeRange, nowMs]);
  const selectedTask = selectedTaskId
    ? (activeTasks.find((task) => task.id === selectedTaskId) ?? null)
    : null;

  if (!featureFlags.taskSpawning) return <TasksWorkflowsDisabledRoute />;
  if (!tasksReady) return <TasksBoardSkeleton />;

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-5 sm:px-6">
        <div className="flex w-full max-w-[1480px] flex-col gap-8 pb-24 pt-14 sm:pt-20">
          <header className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
                Tasks
              </h1>
              <p className="text-[13px] leading-5 text-ink-subtle">
                Background runs from workflows, schedules, and chat.
              </p>
            </div>
            <div className="mt-1 flex shrink-0 items-center gap-2">
              <TaskViewModeToggle value={viewMode} onChange={setViewMode} />
              <Select
                value={timeRange}
                onValueChange={(value) => {
                  if (isTaskTimeRange(value)) setTimeRange(value);
                }}
              >
                <SelectTrigger
                  aria-label="Filter tasks by time range"
                  className="h-7 w-[132px] shrink-0 border-border-subtle bg-surface px-2 text-[11.5px] text-ink shadow-none"
                >
                  <SelectValue>{TASK_TIME_RANGE_LABELS[timeRange]}</SelectValue>
                </SelectTrigger>
                <SelectContent className="min-w-[140px]">
                  {TASK_TIME_RANGE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option} className="text-[12px]">
                      {TASK_TIME_RANGE_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </header>

          {activeTasks.length === 0 ? (
            <EmptyState
              icon={ListTodo}
              title="No tasks yet"
              description="Fire a workflow with # in chat, start an ad-hoc task, or set up a scheduled run — each run shows up here."
            />
          ) : viewMode === "list" ? (
            <TaskListView
              columns={columns}
              workflowNames={workflowNames}
              onSelectTask={setSelectedTaskId}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              {TASK_BOARD_COLUMNS.map((column) => (
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

export function TasksBoardSkeleton() {
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
            {TASK_BOARD_COLUMNS.map((column) => (
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

const TASK_VIEW_MODE_OPTIONS = [
  { value: "board", label: "Board", icon: LayoutGrid },
  { value: "list", label: "List", icon: Rows3 },
] as const satisfies ReadonlyArray<{
  value: TaskViewMode;
  label: string;
  icon: typeof LayoutGrid;
}>;

function TaskViewModeToggle({
  value,
  onChange,
}: {
  value: TaskViewMode;
  onChange: (mode: TaskViewMode) => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const currentIndex = TASK_VIEW_MODE_OPTIONS.findIndex((option) => option.value === value);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex =
      (currentIndex + delta + TASK_VIEW_MODE_OPTIONS.length) % TASK_VIEW_MODE_OPTIONS.length;
    const next = TASK_VIEW_MODE_OPTIONS[nextIndex];
    if (next) onChange(next.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Task view"
      onKeyDown={handleKeyDown}
      className="inline-flex h-7 w-fit shrink-0 rounded-lg border border-border-subtle bg-surface p-0.5"
    >
      {TASK_VIEW_MODE_OPTIONS.map((option) => {
        const Icon = option.icon;
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-6 w-7 items-center justify-center rounded-md transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              selected
                ? "bg-surface-active text-ink shadow-[0_1px_1px_rgba(15,15,15,0.05)]"
                : "text-ink-muted hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Icon size={13} strokeWidth={1.9} />
          </button>
        );
      })}
    </div>
  );
}

function TaskListView({
  columns,
  workflowNames,
  onSelectTask,
}: {
  columns: Record<TaskBoardColumn, TaskView[]>;
  workflowNames: Record<string, string>;
  onSelectTask: (taskId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      {TASK_BOARD_COLUMNS.map((column) => (
        <TaskListSection
          key={column}
          column={column}
          tasks={columns[column]}
          workflowNames={workflowNames}
          onSelectTask={onSelectTask}
        />
      ))}
    </div>
  );
}

function TaskListSection({
  column,
  tasks,
  workflowNames,
  onSelectTask,
}: {
  column: TaskBoardColumn;
  tasks: TaskView[];
  workflowNames: Record<string, string>;
  onSelectTask: (taskId: string) => void;
}) {
  const label = TASK_BOARD_COLUMN_COPY[column];
  const [expanded, setExpanded] = useState(false);
  const capped = CAPPED_TASK_BOARD_COLUMNS.has(column) && !expanded;
  const visibleTasks = capped ? tasks.slice(0, TASK_BOARD_COLUMN_CAP) : tasks;
  const remaining = tasks.length - visibleTasks.length;

  if (tasks.length === 0) return null;

  return (
    <section aria-label={label} className="flex min-w-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-1 pb-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
          {label}
        </h2>
        <span className="min-w-5 rounded-full bg-surface-muted px-1.5 py-0.5 text-center text-[10.5px] font-medium tabular-nums text-ink-subtle">
          {tasks.length}
        </span>
      </header>
      <ul className="flex flex-col divide-y divide-border-subtle">
        {visibleTasks.map((task) => (
          <li key={task.id}>
            <TaskListRow
              task={task}
              sourceLabel={taskSourceLabel(task, workflowNames)}
              onSelect={() => onSelectTask(task.id)}
            />
          </li>
        ))}
      </ul>
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 flex min-h-9 w-full items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-[11.5px] font-medium leading-5 text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          Show {remaining} more
        </button>
      ) : null}
    </section>
  );
}

function TaskListRow({
  task,
  sourceLabel,
  onSelect,
}: {
  task: TaskView;
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
      aria-label={`Open ${toTaskTitle(task.name)}`}
      className="group flex min-w-0 items-center gap-3 px-1.5 py-2.5 text-left transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <TaskStatusDot task={task} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-ink">
        {toTaskTitle(task.name)}
      </span>
      <span className="hidden shrink-0 truncate rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] font-medium leading-4 text-ink-muted sm:inline-block sm:max-w-[160px]">
        {sourceLabel}
      </span>
      <span className="w-16 shrink-0 text-right text-[11px] leading-4 text-ink-subtle">
        {formatRelativeTime(task.updatedAt)}
      </span>
    </Link>
  );
}

function TaskBoardColumn({
  column,
  tasks,
  workflowNames,
  onSelectTask,
}: {
  column: TaskBoardColumn;
  tasks: TaskView[];
  workflowNames: Record<string, string>;
  onSelectTask: (taskId: string) => void;
}) {
  const label = TASK_BOARD_COLUMN_COPY[column];
  const [expanded, setExpanded] = useState(false);
  const capped = CAPPED_TASK_BOARD_COLUMNS.has(column) && !expanded;
  const visibleTasks = capped ? tasks.slice(0, TASK_BOARD_COLUMN_CAP) : tasks;
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
  task: TaskView;
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
      aria-label={`Open ${toTaskTitle(task.name)}`}
      className="group flex w-full items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-left transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
    >
      <TaskStatusDot task={task} className="mt-[6px]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium leading-tight text-ink">
          {toTaskTitle(task.name)}
        </span>
        <span className="mt-1 line-clamp-2 block text-[12px] leading-[1.45] text-ink-subtle">
          {task.outcomeComment?.trim() || taskBoardStatusCopy(task)}
        </span>
        <span className="mt-2 flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] font-medium leading-4 text-ink-muted">
            {sourceLabel}
          </span>
          <span className="shrink-0 text-[10.5px] leading-4 text-ink-subtle">
            {formatRelativeTime(task.updatedAt)}
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
  task: TaskView;
  workflowNames: Record<string, string>;
  onClose: () => void;
}) {
  const { schedules } = useAppData();
  const [isArchiving, startArchiveTransition] = useTransition();
  const schedule = task.scheduleId
    ? (schedules.find((candidate) => candidate.id === task.scheduleId) ?? null)
    : null;
  const terminal = TERMINAL_TASK_STATUSES.has(task.status);
  const { summary, error: summaryError } = useTaskSummary(task.id, terminal);
  const durationLabel = !terminal
    ? null
    : summary?.durationMs !== null && summary?.durationMs !== undefined
      ? formatTaskDurationMs(summary.durationMs)
      : summary
        ? formatTaskDuration(task.createdAt, task.updatedAt)
        : null;
  const activityEntries = buildTaskActivityEntries({
    task,
    terminal,
    sourceLabel: taskSourceLabel(task, workflowNames),
    durationLabel,
  });
  const pullRequestUrl = terminal
    ? extractGitHubPullRequestUrl(task.result, task.outcomeComment)
    : null;

  const archiveTask = () => {
    if (!terminal) return;
    startArchiveTransition(async () => {
      const result = await archiveTaskAction(task.id);
      if (!result.ok) {
        toast.error(result.error ?? `Could not archive "${task.name}".`);
        return;
      }
      onClose();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="left-auto right-0 top-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-y-0 border-r-0 bg-surface p-0 text-ink data-[ending-style]:translate-x-full data-[ending-style]:scale-100 data-[ending-style]:opacity-100 data-[starting-style]:translate-x-full data-[starting-style]:scale-100 data-[starting-style]:opacity-100 sm:w-[720px] sm:max-w-[calc(100vw-2rem)]">
        <header className="border-b border-border px-5 pb-4 pt-5 pr-12">
          <DialogTitle className="text-[17px] font-semibold leading-6 text-ink">
            {toTaskTitle(task.name)}
          </DialogTitle>
          <DialogDescription className="mt-1 font-mono text-[11px] leading-4 text-ink-subtle">
            {task.displayId}
          </DialogDescription>
        </header>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-5">
            <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-muted">
              {task.prompt}
            </p>

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
                      Scheduled for {formatStartedAt(task.scheduledFor)}
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
                        <span className="text-ink-subtle">{formatStartedAt(entry.timestamp)}</span>
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

          <aside className="w-full shrink-0 overflow-y-auto border-t border-border px-5 py-4 sm:w-[220px] sm:border-l sm:border-t-0 sm:px-4 sm:py-5">
            <DetailLabel>Properties</DetailLabel>
            <div className="mt-3 flex flex-col gap-4">
              <PropertyRow label="Status">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2 py-1 text-[11.5px] font-medium text-ink">
                  <TaskStatusDot task={task} />
                  {STATUS_COPY[task.status]}
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

              {pullRequestUrl ? (
                <PropertyRow label="Pull request">
                  <a
                    href={pullRequestUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:text-ink-muted"
                  >
                    <GitHubIcon size={13} />
                    View PR
                    <ArrowUpRight size={12} strokeWidth={1.75} />
                  </a>
                </PropertyRow>
              ) : null}
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
  task: TaskView;
  terminal: boolean;
  sourceLabel: string;
  durationLabel: string | null;
}): TaskActivityEntry[] {
  const entries: TaskActivityEntry[] = [
    { id: "created", label: "Created", meta: sourceLabel, timestamp: task.createdAt },
  ];
  for (const step of task.workflowSteps ?? []) {
    entries.push({
      id: `workflow-step-${step.index}`,
      label: `Step ${step.index + 1}/${step.total}: ${step.title}`,
      meta: workflowStepStatusLabel(step.status),
      timestamp: task.updatedAt,
      tone: step.status === "failed" || step.status === "needs_attention" ? "danger" : "default",
    });
  }

  if (!terminal) {
    if (task.updatedAt !== task.createdAt) {
      entries.push({
        id: "status",
        label: STATUS_COPY[task.status],
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

function workflowStepStatusLabel(status: NonNullable<TaskView["workflowSteps"]>[number]["status"]) {
  switch (status) {
    case "completed":
      return "Done";
    case "needs_attention":
      return "Needs attention";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "running":
      return "Running";
    case "pending":
      return "Pending";
  }
}

function TaskStatusDot({ task, className = "" }: { task: TaskView; className?: string }) {
  const dotClass = WORKFLOW_TASK_STATUS_DOT_CLASS[workflowTaskDisplayStatus(task)];
  return (
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass} ${className}`}
    />
  );
}

function taskSourceLabel(task: TaskView, workflowNames: Record<string, string>): string {
  if (task.workflowId) {
    const workflowName = workflowNames[task.workflowId]?.trim();
    if (!workflowName) return `#${task.workflowId}`;
    return workflowName.startsWith("#") ? workflowName : `#${workflowName}`;
  }
  if (task.scheduleId) return "Scheduled";
  return "Ad-hoc";
}
