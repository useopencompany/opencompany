import type { AgentScheduleTriggerConfig } from "./types";

export const AGENT_SCHEDULE_TRIGGER_TYPE = "agent.schedule";

export type AgentSchedulePreset =
  | { kind: "minutes"; interval: number }
  | { kind: "hours"; interval: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; dayOfWeek: number; hour: number; minute: number };

const MINUTE_INTERVAL_RE = /^\*\/([1-9]|[1-5][0-9]) \* \* \* \*$/;
const HOUR_INTERVAL_RE = /^0 \*\/([1-9]|1[0-9]|2[0-3]) \* \* \*$/;
const DAILY_RE = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* \*$/;
const WEEKDAYS_RE = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* 1-5$/;
const WEEKLY_RE = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* ([0-6])$/;

export function cronForSchedulePreset(preset: AgentSchedulePreset) {
  if (preset.kind === "minutes") return `*/${clampInt(preset.interval, 1, 59)} * * * *`;
  if (preset.kind === "hours") return `0 */${clampInt(preset.interval, 1, 23)} * * *`;
  if (preset.kind === "weekdays") {
    return `${clampInt(preset.minute, 0, 59)} ${clampInt(preset.hour, 0, 23)} * * 1-5`;
  }
  if (preset.kind === "weekly") {
    return `${clampInt(preset.minute, 0, 59)} ${clampInt(preset.hour, 0, 23)} * * ${clampInt(
      preset.dayOfWeek,
      0,
      6,
    )}`;
  }
  return `${clampInt(preset.minute, 0, 59)} ${clampInt(preset.hour, 0, 23)} * * *`;
}

export function schedulePresetFromCron(cron: string): AgentSchedulePreset | null {
  const trimmed = cron.trim();
  const minuteInterval = MINUTE_INTERVAL_RE.exec(trimmed);
  if (minuteInterval) {
    return { kind: "minutes", interval: Number.parseInt(minuteInterval[1]!, 10) };
  }

  const hourInterval = HOUR_INTERVAL_RE.exec(trimmed);
  if (hourInterval) {
    return { kind: "hours", interval: Number.parseInt(hourInterval[1]!, 10) };
  }

  const weekdays = WEEKDAYS_RE.exec(trimmed);
  if (weekdays) {
    return {
      kind: "weekdays",
      minute: Number.parseInt(weekdays[1]!, 10),
      hour: Number.parseInt(weekdays[2]!, 10),
    };
  }

  const weekly = WEEKLY_RE.exec(trimmed);
  if (weekly) {
    return {
      kind: "weekly",
      minute: Number.parseInt(weekly[1]!, 10),
      hour: Number.parseInt(weekly[2]!, 10),
      dayOfWeek: Number.parseInt(weekly[3]!, 10),
    };
  }

  const daily = DAILY_RE.exec(trimmed);
  if (daily) {
    return {
      kind: "daily",
      minute: Number.parseInt(daily[1]!, 10),
      hour: Number.parseInt(daily[2]!, 10),
    };
  }

  return null;
}

export function isSupportedScheduleCron(cron: string) {
  return Boolean(schedulePresetFromCron(cron));
}

export function scheduleSummary(trigger: Pick<AgentScheduleTriggerConfig, "cron" | "timezone">) {
  const preset = schedulePresetFromCron(trigger.cron);
  if (!preset) return "Unsupported schedule";

  if (preset.kind === "minutes") return `Every ${preset.interval} minutes`;
  if (preset.kind === "hours") return `Every ${preset.interval} hours`;
  if (preset.kind === "daily") return `Daily at ${formatTime(preset.hour, preset.minute)}`;
  if (preset.kind === "weekdays") {
    return `Weekdays at ${formatTime(preset.hour, preset.minute)}`;
  }

  return `${weekdayName(preset.dayOfWeek)} at ${formatTime(preset.hour, preset.minute)}`;
}

export function scheduleTriggerDueAt(
  trigger: Pick<AgentScheduleTriggerConfig, "cron" | "timezone" | "enabled">,
  now = new Date(),
): Date | null {
  if (!trigger.enabled) return null;
  const preset = schedulePresetFromCron(trigger.cron);
  if (!preset) return null;
  const parts = zonedDateParts(now, trigger.timezone);

  if (preset.kind === "minutes" && parts.minute % preset.interval === 0) {
    return truncateToMinute(now);
  }
  if (preset.kind === "hours" && parts.minute === 0 && parts.hour % preset.interval === 0) {
    return truncateToMinute(now);
  }
  if (preset.kind === "daily" && parts.hour === preset.hour && parts.minute === preset.minute) {
    return truncateToMinute(now);
  }
  if (
    preset.kind === "weekdays" &&
    parts.dayOfWeek >= 1 &&
    parts.dayOfWeek <= 5 &&
    parts.hour === preset.hour &&
    parts.minute === preset.minute
  ) {
    return truncateToMinute(now);
  }
  if (
    preset.kind === "weekly" &&
    parts.dayOfWeek === preset.dayOfWeek &&
    parts.hour === preset.hour &&
    parts.minute === preset.minute
  ) {
    return truncateToMinute(now);
  }

  return null;
}

export function normalizeScheduleTimezone(value: string | null | undefined) {
  const timezone = value?.trim() || "UTC";
  return isValidTimezone(timezone) ? timezone : "UTC";
}

function zonedDateParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeScheduleTimezone(timezone),
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const year = Number.parseInt(values.get("year") ?? "1970", 10);
  const month = Number.parseInt(values.get("month") ?? "1", 10);
  const day = Number.parseInt(values.get("day") ?? "1", 10);

  return {
    hour: Number.parseInt(values.get("hour") ?? "0", 10),
    minute: Number.parseInt(values.get("minute") ?? "0", 10),
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function truncateToMinute(date: Date) {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

function isValidTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function formatTime(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function weekdayName(dayOfWeek: number) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dayOfWeek]!;
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
