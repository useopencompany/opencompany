"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { CalendarClock, Pause, Play, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import { useGoatAppData } from "@/components/GoatAppDataProvider";
import {
  describeCronSchedule,
  formatRelativeTime,
  formatScheduleNextRun,
  getTaskMeta,
  taskRowToView,
} from "@/lib/task-board";
import {
  deleteGoatTaskScheduleAction,
  runGoatTaskScheduleNowAction,
  setGoatTaskScheduleEnabledAction,
  updateGoatTaskScheduleAction,
} from "@/lib/task-schedules";

export function TaskScheduleDetailPanel({ scheduleId }: { scheduleId: string }) {
  const router = useRouter();
  const { schedules, taskRows } = useGoatAppData();
  const schedule = schedules.find((entry) => entry.id === scheduleId) ?? null;
  const [isPending, startTransition] = useTransition();
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editName, setEditName] = useState("");
  const [editCron, setEditCron] = useState("");
  const [editTimezone, setEditTimezone] = useState("");
  const [editPrompt, setEditPrompt] = useState("");

  const occurrences = useMemo(
    () =>
      taskRows
        .filter((row) => row.schedule_id === scheduleId)
        .map(taskRowToView)
        .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [scheduleId, taskRows],
  );

  if (!schedule) {
    return (
      <p className="text-[13px] leading-5 text-ink-subtle">
        Recurring task not found. It may have been deleted.
      </p>
    );
  }

  const openEdit = () => {
    setEditName(schedule.name);
    setEditCron(schedule.cron);
    setEditTimezone(schedule.timezone);
    setEditPrompt(schedule.prompt);
    setIsEditing(true);
  };

  const saveEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await updateGoatTaskScheduleAction(schedule.id, {
        name: editName,
        sourceDescription: describeCronSchedule(editCron.trim().replace(/\s+/g, " ")),
        cron: editCron,
        timezone: editTimezone,
        prompt: editPrompt,
      });
      if (result.ok) {
        setIsEditing(false);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <CalendarClock
              size={22}
              strokeWidth={2}
              className={`mt-1 shrink-0 ${schedule.enabled ? "text-emerald-600" : "text-ink-subtle"}`}
            />
            <div className="min-w-0">
              <h1 className="text-[28px] font-semibold leading-tight text-ink">{schedule.name}</h1>
              <p className="mt-1 text-[13px] leading-5 text-ink-subtle">
                {describeCronSchedule(schedule.cron)} ({schedule.timezone}) ·{" "}
                {schedule.enabled ? formatScheduleNextRun(schedule.nextRunAt) : "Paused"}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              title="Run now"
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  const result = await runGoatTaskScheduleNowAction(schedule.id);
                  if (result.ok) {
                    router.push(`/tasks/${encodeURIComponent(result.task.displayId)}`);
                  } else {
                    toast.error(result.error);
                  }
                });
              }}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              <Play size={15} strokeWidth={2} />
            </button>
            <button
              type="button"
              title={schedule.enabled ? "Pause" : "Resume"}
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  const result = await setGoatTaskScheduleEnabledAction(
                    schedule.id,
                    !schedule.enabled,
                  );
                  if (!result.ok) toast.error(result.error);
                });
              }}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              {schedule.enabled ? (
                <Pause size={15} strokeWidth={2} />
              ) : (
                <Play size={15} strokeWidth={2} />
              )}
            </button>
            <button
              type="button"
              title="Edit"
              disabled={isPending}
              onClick={() => (isEditing ? setIsEditing(false) : openEdit())}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              <Settings size={15} strokeWidth={2} />
            </button>
            <button
              type="button"
              title={confirmingDelete ? "Confirm delete" : "Delete"}
              disabled={isPending}
              onClick={() => {
                if (!confirmingDelete) {
                  setConfirmingDelete(true);
                  return;
                }
                startTransition(async () => {
                  const result = await deleteGoatTaskScheduleAction(schedule.id);
                  if (result.ok) {
                    router.push("/tasks");
                  } else {
                    setConfirmingDelete(false);
                    toast.error(result.error);
                  }
                });
              }}
              className={`flex h-8 items-center justify-center gap-1 rounded-md px-2 transition-colors disabled:opacity-60 ${
                confirmingDelete
                  ? "bg-danger/10 text-danger"
                  : "w-8 text-ink-subtle hover:bg-surface-hover hover:text-ink"
              }`}
            >
              <Trash2 size={15} strokeWidth={2} />
              {confirmingDelete ? <span className="text-[12px] font-medium">Confirm</span> : null}
            </button>
          </div>
        </div>
      </header>

      {isEditing ? (
        <form
          onSubmit={saveEdit}
          className="flex flex-col gap-3 rounded-lg border border-border bg-sidebar p-4"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Name</span>
            <input
              type="text"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink">Cron</span>
              <input
                type="text"
                value={editCron}
                onChange={(event) => setEditCron(event.target.value)}
                className="w-40 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12.5px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink">Timezone</span>
              <input
                type="text"
                value={editTimezone}
                onChange={(event) => setEditTimezone(event.target.value)}
                className="w-52 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Description</span>
            <textarea
              value={editPrompt}
              onChange={(event) => setEditPrompt(event.target.value)}
              rows={4}
              className="resize-none rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] leading-5 text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="rounded-md px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              Save
            </button>
          </div>
        </form>
      ) : (
        <section className="flex flex-col gap-2">
          <h2 className="text-[13px] font-medium text-ink">Description</h2>
          <p className="whitespace-pre-wrap text-[13px] leading-6 text-ink-muted">
            {schedule.prompt}
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-medium text-ink">Past occurrences</h2>
        {occurrences.length === 0 ? (
          <p className="text-[12.5px] leading-5 text-ink-subtle">
            No runs yet. The first occurrence appears here after the schedule fires.
          </p>
        ) : (
          <div className="flex flex-col">
            {occurrences.map((task) => {
              const meta = getTaskMeta(task);
              return (
                <Link
                  key={task.id}
                  href={`/tasks/${encodeURIComponent(task.displayId)}`}
                  prefetch
                  className="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover"
                >
                  <meta.icon
                    size={15}
                    strokeWidth={2}
                    className={`shrink-0 ${meta.className} ${meta.spin ? "animate-spin" : ""}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium leading-5 text-ink">
                      {task.name}
                    </p>
                    <p className="truncate text-[12px] leading-4 text-ink-subtle">{meta.detail}</p>
                  </div>
                  <span className="shrink-0 text-[12px] text-ink-subtle">
                    {formatRelativeTime(task.createdAt)}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
