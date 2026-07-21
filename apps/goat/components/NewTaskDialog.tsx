"use client";

import { isValidFiveFieldCron, nextCronRunAt } from "@opencompany/agent-runtime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { toast } from "@opencompany/ui/components/sonner";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import {
  describeCronSchedule,
  type GoatSchedulePreset,
  type GoatTaskView,
  scheduleDraftToCron,
} from "@/lib/task-board";
import { formatGoatStartedAt } from "@/lib/task-display";
import { createGoatTaskScheduleAction } from "@/lib/task-schedules";
import { GOAT_TASK_PROMPT_MAX_LENGTH } from "@/lib/task-validation";
import { createGoatTaskAction } from "@/lib/tasks";

const PRESET_OPTIONS: { value: GoatSchedulePreset; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

const WEEKDAY_OPTIONS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

export function NewTaskDialog({
  open,
  onClose,
  onTaskCreated,
}: {
  open: boolean;
  onClose: () => void;
  onTaskCreated: (task: GoatTaskView) => void;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"once" | "recurring">("once");
  const [preset, setPreset] = useState<GoatSchedulePreset>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [customCron, setCustomCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const cron = useMemo(
    () => scheduleDraftToCron({ preset, time, weekday, dayOfMonth, cron: customCron }),
    [customCron, dayOfMonth, preset, time, weekday],
  );
  const cronValid = mode === "once" || isValidFiveFieldCron(cron, timezone);
  const firstRunAt = useMemo(() => {
    if (mode === "once" || !cronValid) return null;
    return nextCronRunAt(cron, timezone);
  }, [cron, cronValid, mode, timezone]);

  const resetAndClose = () => {
    setName("");
    setPrompt("");
    setMode("once");
    setError(null);
    onClose();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isPending) return;
    if (!prompt.trim()) {
      setError("Describe what the task should do.");
      return;
    }
    if (mode === "recurring" && !cronValid) {
      setError("Enter a valid 5-field cron expression.");
      return;
    }
    setError(null);
    startTransition(async () => {
      if (mode === "once") {
        const result = await createGoatTaskAction({ name, prompt });
        if (result.ok) {
          onTaskCreated(result.task);
          resetAndClose();
        } else {
          setError(result.error);
        }
        return;
      }
      const result = await createGoatTaskScheduleAction({
        name,
        cron,
        timezone,
        prompt,
        sourceDescription: describeCronSchedule(cron),
      });
      if (result.ok) {
        toast.success(`Recurring task "${result.schedule.name}" created.`);
        resetAndClose();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? undefined : resetAndClose())}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Runs start immediately; recurring tasks wait in Todo until their schedule fires.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Title</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional — derived from the description if empty"
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Description</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={GOAT_TASK_PROMPT_MAX_LENGTH}
              rows={4}
              placeholder="What should the agent do?"
              className="resize-none rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] leading-5 text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Repeats</span>
            <div className="flex w-fit rounded-md border border-border bg-surface p-0.5">
              {(
                [
                  { value: "once", label: "One-off" },
                  { value: "recurring", label: "Recurring" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={mode === option.value}
                  onClick={() => setMode(option.value)}
                  className={`rounded px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                    mode === option.value
                      ? "bg-surface-active text-ink"
                      : "text-ink-subtle hover:text-ink"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {mode === "recurring" ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-sidebar p-3">
              <div className="flex flex-wrap gap-1.5">
                {PRESET_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={preset === option.value}
                    onClick={() => setPreset(option.value)}
                    className={`rounded-md border px-2 py-1 text-[12px] font-medium transition-colors ${
                      preset === option.value
                        ? "border-ink/30 bg-surface-active text-ink"
                        : "border-border text-ink-subtle hover:text-ink"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              {preset === "weekly" ? (
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={weekday === option.value}
                      onClick={() => setWeekday(option.value)}
                      className={`rounded-md border px-2 py-1 text-[12px] transition-colors ${
                        weekday === option.value
                          ? "border-ink/30 bg-surface-active text-ink"
                          : "border-border text-ink-subtle hover:text-ink"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}

              {preset === "monthly" ? (
                <label className="flex items-center gap-2 text-[12.5px] text-ink">
                  Day of month
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={dayOfMonth}
                    onChange={(event) => setDayOfMonth(Number(event.target.value) || 1)}
                    className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-[13px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                  />
                </label>
              ) : null}

              {preset === "custom" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-[12.5px] text-ink">
                    Cron
                    <input
                      type="text"
                      value={customCron}
                      onChange={(event) => setCustomCron(event.target.value)}
                      placeholder="0 9 * * 1-5"
                      className="w-36 rounded-md border border-border bg-surface px-2 py-1 font-mono text-[12.5px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-[12.5px] text-ink">
                    Timezone
                    <input
                      type="text"
                      value={timezone}
                      onChange={(event) => setTimezone(event.target.value)}
                      className="w-44 rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                    />
                  </label>
                </div>
              ) : (
                <label className="flex items-center gap-2 text-[12.5px] text-ink">
                  Time
                  <input
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    className="rounded-md border border-border bg-surface px-2 py-1 text-[13px] text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                  />
                </label>
              )}

              <p className="text-[12px] leading-4 text-ink-subtle">
                {cronValid && firstRunAt
                  ? `${describeCronSchedule(cron)} · first run ${formatGoatStartedAt(firstRunAt)}`
                  : "Enter a valid schedule."}
              </p>
            </div>
          ) : null}

          {error ? <p className="text-[12.5px] leading-5 text-danger">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={resetAndClose}
              className="rounded-md px-3 py-1.5 text-[13px] font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {isPending
                ? "Creating..."
                : mode === "once"
                  ? "Create & run"
                  : "Create recurring task"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
