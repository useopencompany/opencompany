import { scheduleNextRunAt } from "@opencompany/agent-runtime";
import type { AgentScheduleTriggerConfig } from "@opencompany/agent-runtime/types";

/** Narrow an agent's mixed `config.triggers` down to its schedule (routine) triggers. */
export function scheduleTriggers(triggers: readonly unknown[]): AgentScheduleTriggerConfig[] {
  return triggers.filter((trigger): trigger is AgentScheduleTriggerConfig => {
    if (!trigger || typeof trigger !== "object" || !("type" in trigger)) return false;
    return (trigger as { type: unknown }).type === "agent.schedule";
  });
}

/** Insert or replace a schedule trigger by id, preserving order. */
export function upsertScheduleTrigger(
  triggers: AgentScheduleTriggerConfig[],
  next: AgentScheduleTriggerConfig,
): AgentScheduleTriggerConfig[] {
  const index = triggers.findIndex((trigger) => trigger.id === next.id);
  if (index === -1) return [...triggers, next];
  return triggers.map((trigger, triggerIndex) => (triggerIndex === index ? next : trigger));
}

/** Human label for a routine's next run, e.g. "Next run in 2 hours · today at 9:00 AM". */
export function nextRunLabel(routine: AgentScheduleTriggerConfig, now: Date): string {
  if (!routine.enabled) return "Paused";
  const nextRunAt = scheduleNextRunAt(routine, now);
  if (!nextRunAt) return "No upcoming run";
  return `Next run ${relativeNextRun(nextRunAt, now)} · ${localNextRunTime(
    nextRunAt,
    routine.timezone,
    now,
  )}`;
}

export function relativeNextRun(nextRunAt: Date, now: Date): string {
  const minutes = Math.max(1, Math.ceil((nextRunAt.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in about ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(minutes / (24 * 60));
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

export function localNextRunTime(nextRunAt: Date, timezone: string, now: Date): string {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(nextRunAt);
  const nextKey = localDateKey(nextRunAt, timezone);
  const todayKey = localDateKey(now, timezone);
  const tomorrowKey = localDateKey(new Date(now.getTime() + 24 * 60 * 60_000), timezone);

  if (nextKey === todayKey) return `today at ${time}`;
  if (nextKey === tomorrowKey) return `tomorrow at ${time}`;

  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(nextRunAt);
  return `${day} at ${time}`;
}

function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}
