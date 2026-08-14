import {
  isValidFiveFieldCron,
  nextCronRunAt,
  normalizeScheduleTimezone,
} from "@opencompany/agent-runtime";

export function normalizeScheduleDefinition(input: {
  cron: string;
  timezone?: string | null;
  now: Date;
}) {
  const cron = input.cron.trim().replace(/\s+/gu, " ");
  const timezone = normalizeScheduleTimezone(input.timezone);
  if (!isValidFiveFieldCron(cron, timezone)) return null;
  const nextRunAt = nextCronRunAt(cron, timezone, input.now);
  return nextRunAt ? { cron, timezone, nextRunAt } : null;
}
