import {
  AGENT_SCHEDULE_TRIGGER_TYPE,
  isSupportedScheduleCron,
  normalizeScheduleTimezone,
} from "@opencompany/agent-runtime";
import type { AgentScheduleTriggerConfig } from "@opencompany/agent-runtime/types";

export type ParseScheduleTriggersResult =
  | { ok: true; value: AgentScheduleTriggerConfig[] }
  | { ok: false; error: string };

/**
 * Validate + normalize an untrusted list of schedule triggers (the shape `ScheduleDialog`
 * produces) into `AgentScheduleTriggerConfig`s safe to persist on an agent's config.
 *
 * Shared by the personal-agent and workspace-agent schedule writers so both apply identical
 * cron/prompt/id rules. Pass `options.timezone` to force every trigger onto one timezone
 * (personal agents inherit the user's timezone); omit it to keep each trigger's own timezone
 * (workspace routines can target different timezones).
 */
export function parseScheduleTriggers(
  schedules: readonly unknown[],
  options?: { timezone?: string },
): ParseScheduleTriggersResult {
  if (!Array.isArray(schedules)) {
    return { ok: false, error: "Routines must be a list." };
  }

  const forcedTimezone =
    options?.timezone !== undefined ? normalizeScheduleTimezone(options.timezone) : null;
  const ids = new Set<string>();
  const triggers: AgentScheduleTriggerConfig[] = [];

  for (const [index, item] of schedules.entries()) {
    const label = `Routine ${index + 1}`;
    if (!item || typeof item !== "object") {
      return { ok: false, error: `${label} is invalid.` };
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const cron = typeof record.cron === "string" ? record.cron.trim() : "";
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";

    if (!id) return { ok: false, error: `${label} needs an id.` };
    if (ids.has(id)) return { ok: false, error: `Duplicate routine id "${id}".` };
    if (!cron || !isSupportedScheduleCron(cron)) {
      return { ok: false, error: `${label} has an unsupported schedule.` };
    }
    if (!prompt) return { ok: false, error: `${label} needs a prompt.` };

    const timezone =
      forcedTimezone ??
      normalizeScheduleTimezone(typeof record.timezone === "string" ? record.timezone : undefined);

    ids.add(id);
    triggers.push({
      id,
      type: AGENT_SCHEDULE_TRIGGER_TYPE,
      cron,
      timezone,
      prompt,
      enabled: record.enabled === true,
    });
  }

  return { ok: true, value: triggers };
}
