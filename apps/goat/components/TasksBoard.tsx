"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Archive, CalendarClock, Pause, Play, Plus, RotateCcw, Square } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useGoatAppData } from "@/components/GoatAppDataProvider";
import { NewTaskDialog } from "@/components/NewTaskDialog";
import {
  describeCronSchedule,
  formatRelativeTime,
  formatScheduleNextRun,
  type GoatTaskView,
  getTaskMeta,
  goatTaskBoardColumn,
  groupDoneTasks,
  taskRowToView,
} from "@/lib/task-board";
import {
  type GoatTaskScheduleView,
  runGoatTaskScheduleNowAction,
  setGoatTaskScheduleEnabledAction,
} from "@/lib/task-schedules";
import { archiveGoatTaskAction, cancelGoatTaskAction, retryGoatTaskAction } from "@/lib/tasks";

const DONE_GROUP_LIMIT = 20;

export function TasksBoard() {
  const { schedules, taskRows } = useGoatAppData();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<readonly GoatTaskView[]>([]);
  const [archivedIds, setArchivedIds] = useState<ReadonlySet<string>>(new Set());
  const [showAllDone, setShowAllDone] = useState(false);

  const tasks = useMemo(() => {
    const views = taskRows.map(taskRowToView);
    const liveIds = new Set(views.map((task) => task.id));
    // Optimistic cards are dropped as soon as their Electric row arrives.
    return [...pendingTasks.filter((task) => !liveIds.has(task.id)), ...views].filter(
      (task) => !archivedIds.has(task.id),
    );
  }, [archivedIds, pendingTasks, taskRows]);

  const { todoTasks, inProgressTasks, doneTasks } = useMemo(() => {
    const todo: GoatTaskView[] = [];
    const inProgress: GoatTaskView[] = [];
    const done: GoatTaskView[] = [];
    for (const task of tasks) {
      const column = goatTaskBoardColumn(task);
      if (column === "todo") todo.push(task);
      else if (column === "in_progress") inProgress.push(task);
      else if (column === "done") done.push(task);
    }
    const byUpdatedDesc = (a: GoatTaskView, b: GoatTaskView) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    return {
      todoTasks: todo.toSorted(byUpdatedDesc),
      inProgressTasks: inProgress.toSorted(byUpdatedDesc),
      doneTasks: done,
    };
  }, [tasks]);

  const doneGroups = useMemo(() => groupDoneTasks(doneTasks), [doneTasks]);
  const visibleDoneGroups = showAllDone ? doneGroups : doneGroups.slice(0, DONE_GROUP_LIMIT);

  const archiveTask = (task: GoatTaskView) => {
    setArchivedIds((prev) => new Set([...prev, task.id]));
    void archiveGoatTaskAction(task.id).then((result) => {
      if (!result.ok) {
        setArchivedIds((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
        toast.error(result.error ?? "Could not archive task.");
      }
    });
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 px-6 pb-4 pt-8">
        <h1 className="text-[20px] font-semibold leading-tight text-ink">Tasks</h1>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover"
        >
          <Plus size={14} strokeWidth={2} />
          New task
        </button>
      </header>

      <div className="flex min-h-0 flex-1 snap-x gap-4 overflow-x-auto px-6 pb-6 md:grid md:grid-cols-3 md:overflow-x-visible">
        <BoardColumn title="Todo" count={schedules.length + todoTasks.length}>
          {schedules.length === 0 && todoTasks.length === 0 ? (
            <ColumnEmptyState>No recurring tasks yet.</ColumnEmptyState>
          ) : (
            <>
              {schedules.map((schedule) => (
                <RecurringTemplateCard key={schedule.id} schedule={schedule} />
              ))}
              {todoTasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </>
          )}
        </BoardColumn>

        <BoardColumn title="In Progress" count={inProgressTasks.length}>
          {inProgressTasks.length === 0 ? (
            <ColumnEmptyState>Nothing running right now.</ColumnEmptyState>
          ) : (
            inProgressTasks.map((task) => <TaskCard key={task.id} task={task} />)
          )}
        </BoardColumn>

        <BoardColumn title="Done" count={doneGroups.length}>
          {doneGroups.length === 0 ? (
            <ColumnEmptyState>Finished tasks land here.</ColumnEmptyState>
          ) : (
            <>
              {visibleDoneGroups.map((group) => (
                <DoneTaskGroup key={group.latest.id} group={group} onArchive={archiveTask} />
              ))}
              {doneGroups.length > DONE_GROUP_LIMIT && !showAllDone ? (
                <button
                  type="button"
                  onClick={() => setShowAllDone(true)}
                  className="rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
                >
                  Show {doneGroups.length - DONE_GROUP_LIMIT} older
                </button>
              ) : null}
            </>
          )}
        </BoardColumn>
      </div>

      <NewTaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onTaskCreated={(task) => setPendingTasks((prev) => [task, ...prev])}
      />
    </div>
  );
}

function BoardColumn({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-h-0 w-[280px] shrink-0 snap-start flex-col rounded-xl bg-sidebar md:w-auto"
    >
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <h2 className="text-[12.5px] font-medium uppercase tracking-wide text-ink-subtle">
          {title}
        </h2>
        <span className="text-[12px] tabular-nums text-ink-subtle">{count}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">{children}</div>
    </section>
  );
}

function ColumnEmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12.5px] leading-5 text-ink-subtle">
      {children}
    </p>
  );
}

function RecurringTemplateCard({ schedule }: { schedule: GoatTaskScheduleView }) {
  const [isPending, startTransition] = useTransition();

  return (
    <div className="group/card relative rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-surface-hover">
      <Link
        href={`/tasks/schedules/${encodeURIComponent(schedule.id)}`}
        prefetch
        className="absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <span className="sr-only">Open {schedule.name}</span>
      </Link>
      <div className="flex items-start gap-2.5">
        <CalendarClock
          size={15}
          strokeWidth={2}
          className={`mt-0.5 shrink-0 ${schedule.enabled ? "text-emerald-600" : "text-ink-subtle"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium leading-5 text-ink">{schedule.name}</p>
          <p className="truncate text-[12px] leading-4 text-ink-subtle">
            {describeCronSchedule(schedule.cron)}
            {" · "}
            {schedule.enabled ? formatScheduleNextRun(schedule.nextRunAt) : "Paused"}
          </p>
        </div>
      </div>
      <div className="relative mt-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 group-focus-within/card:opacity-100">
        <CardActionButton
          label={`Run ${schedule.name} now`}
          title="Run now"
          disabled={isPending}
          onClick={() => {
            startTransition(async () => {
              const result = await runGoatTaskScheduleNowAction(schedule.id);
              if (!result.ok) toast.error(result.error);
            });
          }}
        >
          <Play size={13} strokeWidth={2} />
        </CardActionButton>
        <CardActionButton
          label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
          title={schedule.enabled ? "Pause" : "Resume"}
          disabled={isPending}
          onClick={() => {
            startTransition(async () => {
              const result = await setGoatTaskScheduleEnabledAction(schedule.id, !schedule.enabled);
              if (!result.ok) toast.error(result.error);
            });
          }}
        >
          {schedule.enabled ? (
            <Pause size={13} strokeWidth={2} />
          ) : (
            <Play size={13} strokeWidth={2} />
          )}
        </CardActionButton>
      </div>
    </div>
  );
}

function TaskCard({ task }: { task: GoatTaskView }) {
  const meta = getTaskMeta(task);
  const [isPending, startTransition] = useTransition();
  const running = task.status === "queued" || task.status === "running";

  return (
    <div className="group/card relative rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-surface-hover">
      <Link
        href={`/tasks/${encodeURIComponent(task.displayId)}`}
        prefetch
        className="absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <span className="sr-only">Open {task.name}</span>
      </Link>
      <div className="flex items-start gap-2.5">
        <meta.icon
          size={15}
          strokeWidth={2}
          className={`mt-0.5 shrink-0 ${meta.className} ${meta.spin ? "animate-spin" : ""}`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium leading-5 text-ink">{task.name}</p>
          <p className="truncate text-[12px] leading-4 text-ink-subtle">{meta.detail}</p>
          <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">
            {task.displayId} · {formatRelativeTime(task.createdAt)}
          </p>
        </div>
      </div>
      {running ? (
        <div className="relative mt-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 group-focus-within/card:opacity-100">
          <CardActionButton
            label={`Stop ${task.name}`}
            title="Stop"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                const result = await cancelGoatTaskAction(task.id);
                if (!result.ok) toast.error(result.error ?? "Could not stop task.");
              });
            }}
          >
            <Square size={13} strokeWidth={2} />
          </CardActionButton>
        </div>
      ) : null}
    </div>
  );
}

function DoneTaskGroup({
  group,
  onArchive,
}: {
  group: { latest: GoatTaskView; older: GoatTaskView[] };
  onArchive: (task: GoatTaskView) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <DoneTaskCard task={group.latest} onArchive={onArchive} />
      {group.older.length > 0 ? (
        expanded ? (
          group.older.map((task) => (
            <DoneTaskCard key={task.id} task={task} onArchive={onArchive} />
          ))
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-md px-2 py-1 text-left text-[12px] text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
          >
            {group.older.length} earlier {group.older.length === 1 ? "run" : "runs"}
          </button>
        )
      ) : null}
    </div>
  );
}

function DoneTaskCard({
  task,
  onArchive,
}: {
  task: GoatTaskView;
  onArchive: (task: GoatTaskView) => void;
}) {
  const meta = getTaskMeta(task);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="group/card relative rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-surface-hover">
      <Link
        href={`/tasks/${encodeURIComponent(task.displayId)}`}
        prefetch
        className="absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <span className="sr-only">Open {task.name}</span>
      </Link>
      <div className="flex items-start gap-2.5">
        <meta.icon size={15} strokeWidth={2} className={`mt-0.5 shrink-0 ${meta.className}`} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="truncate text-[13.5px] font-medium leading-5 text-ink">{task.name}</p>
            {task.status === "failed" ? (
              <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger">
                Failed
              </span>
            ) : null}
            {task.status === "canceled" ? (
              <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-[11px] font-medium text-ink-subtle">
                Canceled
              </span>
            ) : null}
          </div>
          <p className="truncate text-[12px] leading-4 text-ink-subtle">{meta.detail}</p>
          <p className="mt-1 text-[11.5px] leading-4 text-ink-subtle">
            {task.displayId} · {formatRelativeTime(task.updatedAt)}
          </p>
        </div>
      </div>
      <div className="relative mt-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 group-focus-within/card:opacity-100">
        {task.status === "failed" || task.status === "canceled" ? (
          <CardActionButton
            label={`Retry ${task.name}`}
            title="Retry"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                const result = await retryGoatTaskAction(task.id);
                if (!result.ok) toast.error(result.error);
              });
            }}
          >
            <RotateCcw size={13} strokeWidth={2} />
          </CardActionButton>
        ) : null}
        <CardActionButton
          label={`Archive ${task.name}`}
          title="Archive"
          disabled={isPending}
          onClick={() => onArchive(task)}
        >
          <Archive size={13} strokeWidth={2} />
        </CardActionButton>
      </div>
    </div>
  );
}

function CardActionButton({
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60"
    >
      {children}
    </button>
  );
}
