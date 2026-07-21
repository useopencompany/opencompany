import type { GoatTaskStage, GoatTaskStatus } from "@opencompany/db/goat-schema";
import { AlertCircle, CheckCircle2, CircleDotDashed, Clock, type FileText, X } from "lucide-react";
import type { GoatTaskRow } from "@/lib/task-collections";
import { GOAT_STAGE_COPY, GOAT_STATUS_COPY } from "@/lib/task-display";

export type GoatTaskView = {
  id: string;
  displayId: string;
  name: string;
  prompt: string;
  model: string;
  scheduleId?: string | null;
  scheduledFor?: string | null;
  status: GoatTaskStatus;
  stage: GoatTaskStage;
  result: string | null;
  error: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function taskRowToView(row: GoatTaskRow): GoatTaskView {
  return {
    id: row.id,
    displayId: row.display_id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    stage: row.stage,
    result: row.result,
    error: row.error,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type GoatTaskBoardColumn = "todo" | "in_progress" | "done" | "archived";

export function goatTaskBoardColumn(
  task: Pick<GoatTaskView, "status" | "archivedAt" | "scheduledFor">,
  now: Date = new Date(),
): GoatTaskBoardColumn {
  if (task.archivedAt) return "archived";
  if (task.status === "queued" || task.status === "running") {
    // One-offs scheduled for the future wait in Todo until their slot arrives.
    if (
      task.status === "queued" &&
      task.scheduledFor &&
      new Date(task.scheduledFor).getTime() > now.getTime()
    ) {
      return "todo";
    }
    return "in_progress";
  }
  return "done";
}

export function getTaskMeta(task: GoatTaskView): {
  icon: typeof FileText;
  className: string;
  detail: string;
  spin: boolean;
} {
  const recurringPrefix = task.scheduleId ? "Recurring - " : "";
  if (task.status === "failed") {
    return {
      icon: AlertCircle,
      className: "text-danger",
      detail: `${recurringPrefix}${task.error ?? GOAT_STATUS_COPY.failed}`,
      spin: false,
    };
  }
  if (task.status === "canceled") {
    return {
      icon: X,
      className: "text-ink-subtle",
      detail: `${recurringPrefix}${task.error ?? GOAT_STATUS_COPY.canceled}`,
      spin: false,
    };
  }
  if (task.status === "succeeded") {
    return {
      icon: CheckCircle2,
      className: "text-emerald-600",
      detail: `${recurringPrefix}${firstLine(task.result) ?? GOAT_STATUS_COPY.succeeded}`,
      spin: false,
    };
  }
  if (task.status === "queued") {
    return {
      icon: Clock,
      className: "text-ink-subtle",
      detail: `${recurringPrefix}${GOAT_STAGE_COPY[task.stage]}`,
      spin: false,
    };
  }
  return {
    icon: CircleDotDashed,
    className: "text-amber-500",
    detail: `${recurringPrefix}${GOAT_STAGE_COPY[task.stage]}`,
    spin: true,
  };
}

export function firstLine(value: string | null) {
  const line = value?.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!line) return null;
  return line.length > 72 ? `${line.slice(0, 72).trimEnd()}...` : line;
}

export function formatScheduleNextRun(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Next run unknown";
  const minutes = Math.max(1, Math.ceil((timestamp - Date.now()) / 60_000));
  if (minutes < 60) return `Next in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `Next in ${hours}h`;
  const days = Math.round(minutes / 1440);
  return `Next in ${days}d`;
}

export function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  const elapsedMs = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || elapsedMs < 30_000) return "just now";

  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

export type GoatSchedulePreset = "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export type GoatScheduleDraft = {
  preset: GoatSchedulePreset;
  // "HH:MM" in the schedule's timezone.
  time: string;
  // 0 (Sunday) through 6 (Saturday); used when preset is "weekly".
  weekday: number;
  // 1 through 31; used when preset is "monthly".
  dayOfMonth: number;
  // Raw five-field expression; used when preset is "custom".
  cron: string;
};

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function scheduleDraftToCron(draft: GoatScheduleDraft): string {
  if (draft.preset === "custom") return draft.cron.trim();
  const [hourText, minuteText] = draft.time.split(":");
  const hour = Number.parseInt(hourText ?? "", 10);
  const minute = Number.parseInt(minuteText ?? "", 10);
  const h = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9;
  const m = Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0;
  switch (draft.preset) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${Math.min(6, Math.max(0, Math.trunc(draft.weekday)))}`;
    case "monthly":
      return `${m} ${h} ${Math.min(31, Math.max(1, Math.trunc(draft.dayOfMonth)))} * *`;
  }
}

const DEFAULT_SCHEDULE_DRAFT: Omit<GoatScheduleDraft, "preset" | "cron"> = {
  time: "09:00",
  weekday: 1,
  dayOfMonth: 1,
};

export function cronToScheduleDraft(cron: string): GoatScheduleDraft {
  const trimmed = cron.trim();
  const fallback: GoatScheduleDraft = {
    ...DEFAULT_SCHEDULE_DRAFT,
    preset: "custom",
    cron: trimmed,
  };
  const match = trimmed.match(/^(\d{1,2}) (\d{1,2}) (\S+) (\S+) (\S+)$/);
  if (!match) return fallback;
  const [, minuteText, hourText, dayOfMonth, month, weekday] = match;
  if (!minuteText || !hourText || !dayOfMonth || !month || !weekday) return fallback;
  const minute = Number.parseInt(minuteText, 10);
  const hour = Number.parseInt(hourText, 10);
  if (minute > 59 || hour > 23 || month !== "*") return fallback;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (dayOfMonth === "*" && weekday === "*") {
    return { ...DEFAULT_SCHEDULE_DRAFT, preset: "daily", time, cron: trimmed };
  }
  if (dayOfMonth === "*" && weekday === "1-5") {
    return { ...DEFAULT_SCHEDULE_DRAFT, preset: "weekdays", time, cron: trimmed };
  }
  if (dayOfMonth === "*" && /^[0-6]$/.test(weekday)) {
    return {
      ...DEFAULT_SCHEDULE_DRAFT,
      preset: "weekly",
      time,
      weekday: Number.parseInt(weekday, 10),
      cron: trimmed,
    };
  }
  if (weekday === "*" && /^\d{1,2}$/.test(dayOfMonth)) {
    const day = Number.parseInt(dayOfMonth, 10);
    if (day >= 1 && day <= 31) {
      return {
        ...DEFAULT_SCHEDULE_DRAFT,
        preset: "monthly",
        time,
        dayOfMonth: day,
        cron: trimmed,
      };
    }
  }
  return fallback;
}

export function describeCronSchedule(cron: string): string {
  const draft = cronToScheduleDraft(cron);
  switch (draft.preset) {
    case "daily":
      return `Every day at ${draft.time}`;
    case "weekdays":
      return `Weekdays at ${draft.time}`;
    case "weekly":
      return `Every ${WEEKDAY_NAMES[draft.weekday]} at ${draft.time}`;
    case "monthly":
      return `Monthly on day ${draft.dayOfMonth} at ${draft.time}`;
    case "custom":
      return `Cron: ${draft.cron}`;
  }
}

export type GoatDoneTaskGroup = {
  latest: GoatTaskView;
  older: GoatTaskView[];
};

// Groups Done-column cards so recurring occurrences don't flood the column:
// one group per schedule (latest occurrence surfaced, older ones collapsed)
// and one group per one-off task.
export function groupDoneTasks(tasks: readonly GoatTaskView[]): GoatDoneTaskGroup[] {
  const sorted = [...tasks].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const groups = new Map<string, GoatDoneTaskGroup>();
  for (const task of sorted) {
    const key = task.scheduleId ? `schedule:${task.scheduleId}` : `task:${task.id}`;
    const group = groups.get(key);
    if (group) {
      group.older.push(task);
    } else {
      groups.set(key, { latest: task, older: [] });
    }
  }
  return [...groups.values()];
}
