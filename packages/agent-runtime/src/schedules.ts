import { CronExpressionParser } from "cron-parser";
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
const HOUR_LIST_RE = /^0 ((?:[0-9]|1[0-9]|2[0-3])(?:,(?:[0-9]|1[0-9]|2[0-3]))+) \* \* \*$/;
const DAILY_RE = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* \*$/;
const WEEKDAYS_RE = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* 1-5$/;
const WEEKLY_RE = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* ([0-6])$/;
export const SUPPORTED_HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12] as const;

export function cronForSchedulePreset(preset: AgentSchedulePreset) {
  if (preset.kind === "minutes") return `*/${clampInt(preset.interval, 1, 59)} * * * *`;
  if (preset.kind === "hours") {
    return `0 ${hourListForInterval(normalizeHourInterval(preset.interval))} * * *`;
  }
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
    const interval = Number.parseInt(hourInterval[1]!, 10);
    return isSupportedHourInterval(interval) ? { kind: "hours", interval } : null;
  }

  const hourList = HOUR_LIST_RE.exec(trimmed);
  if (hourList) {
    const interval = intervalFromHourList(hourList[1]!);
    return interval ? { kind: "hours", interval } : null;
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

export function scheduleNextRunAt(
  trigger: Pick<AgentScheduleTriggerConfig, "cron" | "timezone" | "enabled">,
  now = new Date(),
): Date | null {
  if (!trigger.enabled || !isSupportedScheduleCron(trigger.cron)) return null;

  let cursor = new Date(truncateToMinute(now).getTime() + 60_000);
  const end = new Date(cursor.getTime() + 8 * 24 * 60 * 60_000);
  while (cursor <= end) {
    const dueAt = scheduleTriggerDueAt(trigger, cursor);
    if (dueAt) return dueAt;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return null;
}

export function normalizeScheduleTimezone(value: string | null | undefined) {
  const timezone = value?.trim() || "UTC";
  return isValidTimezone(timezone) ? timezone : "UTC";
}

export function isValidFiveFieldCron(cron: string, timezone = "UTC") {
  try {
    parseFiveFieldCron(cron, timezone, new Date());
    return true;
  } catch {
    return false;
  }
}

export function nextCronRunAt(cron: string, timezone: string, from = new Date()): Date | null {
  try {
    return parseFiveFieldCron(cron, timezone, from).next().toDate();
  } catch {
    return null;
  }
}

export function latestCronRunAt(cron: string, timezone: string, from = new Date()): Date | null {
  try {
    return parseFiveFieldCron(cron, timezone, new Date(from.getTime() + 1))
      .prev()
      .toDate();
  } catch {
    return null;
  }
}

function parseFiveFieldCron(cron: string, timezone: string, currentDate: Date) {
  const normalizedCron = cron.trim().replace(/\s+/g, " ");
  if (normalizedCron.split(" ").length !== 5) {
    throw new Error("Expected a 5-field cron expression.");
  }
  const normalizedTimezone = normalizeScheduleTimezone(timezone);
  return CronExpressionParser.parse(normalizedCron, {
    currentDate,
    tz: normalizedTimezone,
  });
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

function normalizeHourInterval(value: number) {
  const interval = clampInt(value, 1, 23);
  for (let index = SUPPORTED_HOUR_INTERVALS.length - 1; index >= 0; index -= 1) {
    const supported = SUPPORTED_HOUR_INTERVALS[index]!;
    if (supported <= interval) return supported;
  }
  return 1;
}

function isSupportedHourInterval(
  value: number,
): value is (typeof SUPPORTED_HOUR_INTERVALS)[number] {
  return SUPPORTED_HOUR_INTERVALS.includes(value as (typeof SUPPORTED_HOUR_INTERVALS)[number]);
}

function hourListForInterval(interval: number) {
  const hours = [];
  for (let hour = 0; hour < 24; hour += interval) {
    hours.push(hour);
  }
  return hours.join(",");
}

function intervalFromHourList(value: string) {
  const hours = value.split(",").map((part) => Number.parseInt(part, 10));
  if (hours.some((hour) => !Number.isInteger(hour))) return null;

  for (const interval of SUPPORTED_HOUR_INTERVALS) {
    const expected = hourListForInterval(interval)
      .split(",")
      .map((part) => Number.parseInt(part, 10));
    if (
      hours.length === expected.length &&
      hours.every((hour, index) => hour === expected[index])
    ) {
      return interval;
    }
  }

  return null;
}
