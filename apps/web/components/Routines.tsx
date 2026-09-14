"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { CalendarClock, Pause, Play, Settings, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import {
  archiveHeadlessTaskSchedule,
  runHeadlessTaskScheduleNow,
  updateHeadlessTaskSchedule,
} from "@/lib/headless-automation-commands";
import type { TaskScheduleView } from "@/lib/headless-automation-types";

/**
 * Recurring Tasks ("routines") and their controls. Lives on the Tasks page, which owns background
 * runs; this is the only surface that can pause, edit, run, or delete a schedule.
 */
export function Routines({
  schedules,
  workspaceId,
}: {
  schedules: readonly TaskScheduleView[];
  workspaceId: string;
}) {
  // Soonest first: the next run is what a reader checks a routine list for.
  const ordered = schedules.toSorted(
    (a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime(),
  );

  return (
    <section className="flex flex-col gap-1">
      <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        Routines
      </h2>
      {ordered.map((schedule) => (
        <ScheduleRow key={schedule.id} schedule={schedule} workspaceId={workspaceId} />
      ))}
    </section>
  );
}

function ScheduleRow({
  schedule,
  workspaceId,
}: {
  schedule: TaskScheduleView;
  workspaceId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(schedule.name);
  const [editCron, setEditCron] = useState(schedule.cron);
  const [editTimezone, setEditTimezone] = useState(schedule.timezone);
  const [editPrompt, setEditPrompt] = useState(schedule.prompt);

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
      try {
        await updateHeadlessTaskSchedule(
          schedule.id,
          {
            expectedVersion: schedule.version,
            name: editName,
            sourceDescription: `${editCron.trim()} - ${editTimezone.trim()}`,
            cron: editCron,
            timezone: editTimezone,
            prompt: editPrompt,
          },
          { scopeKey: workspaceId },
        );
        setIsEditing(false);
      } catch (error) {
        toast.error(automationCommandError(error, "Recurring Task update failed."));
      }
    });
  };

  return (
    <div className="group/routine rounded-lg transition-colors duration-150 hover:bg-surface-hover focus-within:bg-surface-hover">
      <div className="flex min-h-12 items-center gap-3 px-2 py-1.5">
        <CalendarClock
          size={16}
          strokeWidth={2}
          className={schedule.enabled ? "shrink-0 text-emerald-600" : "shrink-0 text-ink-subtle"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[14px] font-medium leading-tight text-ink">
              {schedule.name}
            </span>
            <span className="shrink-0 text-[12px] leading-tight text-ink-subtle">
              {schedule.enabled ? formatScheduleNextRun(schedule.nextRunAt) : "Paused"}
            </span>
          </div>
          <p className="truncate text-[12.5px] leading-4 text-ink-subtle">
            {schedule.sourceDescription || `${schedule.cron} - ${schedule.timezone}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/routine:opacity-100 group-focus-within/routine:opacity-100">
          <button
            type="button"
            aria-label={`Run ${schedule.name} now`}
            title="Run now"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                try {
                  const result = await runHeadlessTaskScheduleNow(schedule.id, {
                    scopeKey: workspaceId,
                  });
                  router.push(`/tasks/${encodeURIComponent(result.task.displayId)}`);
                } catch (error) {
                  toast.error(automationCommandError(error, "Recurring Task run failed."));
                }
              });
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60"
          >
            <Play size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label={`Edit ${schedule.name}`}
            title="Edit"
            disabled={isPending}
            onClick={() => {
              if (isEditing) {
                setIsEditing(false);
              } else {
                openEdit();
              }
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60"
          >
            <Settings size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
            title={schedule.enabled ? "Pause" : "Resume"}
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                try {
                  await updateHeadlessTaskSchedule(
                    schedule.id,
                    { expectedVersion: schedule.version, enabled: !schedule.enabled },
                    { scopeKey: workspaceId },
                  );
                } catch (error) {
                  toast.error(automationCommandError(error, "Recurring Task update failed."));
                }
              });
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60"
          >
            {schedule.enabled ? (
              <Pause size={13} strokeWidth={2} />
            ) : (
              <Play size={13} strokeWidth={2} />
            )}
          </button>
          <button
            type="button"
            aria-label={`Delete ${schedule.name}`}
            title="Delete"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                try {
                  await archiveHeadlessTaskSchedule(
                    schedule.id,
                    { expectedVersion: schedule.version },
                    { scopeKey: workspaceId },
                  );
                } catch (error) {
                  toast.error(automationCommandError(error, "Recurring Task archive failed."));
                }
              });
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger-bg disabled:opacity-60"
          >
            <Trash2 size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
      {isEditing ? (
        <form className="flex flex-col gap-2 px-2 pb-2" onSubmit={saveEdit}>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              placeholder="Name"
              disabled={isPending}
              className="min-w-0 rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong"
              required
            />
            <input
              value={editCron}
              onChange={(event) => setEditCron(event.target.value)}
              placeholder="0 9 * * 1"
              disabled={isPending}
              className="min-w-0 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong"
              required
            />
          </div>
          <input
            value={editTimezone}
            onChange={(event) => setEditTimezone(event.target.value)}
            placeholder="Europe/Berlin"
            disabled={isPending}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong"
            required
          />
          <textarea
            value={editPrompt}
            onChange={(event) => setEditPrompt(event.target.value)}
            disabled={isPending}
            className="min-h-20 resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong"
            required
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => setIsEditing(false)}
              className="rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md bg-ink px-2 py-1 text-[12px] font-medium text-canvas transition-opacity disabled:opacity-60"
            >
              Save
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function formatScheduleNextRun(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Next run unknown";
  const minutes = Math.max(1, Math.ceil((timestamp - Date.now()) / 60_000));
  if (minutes < 60) return `Next in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `Next in ${hours}h`;
  const days = Math.round(minutes / 1440);
  return `Next in ${days}d`;
}

function automationCommandError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
