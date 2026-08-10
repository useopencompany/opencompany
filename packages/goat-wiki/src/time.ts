// "Since" parsing for the recent-changes tool: relative shorthand ("2d",
// "6h", "1w", "30m", "last 3 days") or any ISO/parseable date.

const RELATIVE_SINCE = /^(\d+)\s*([mhdw])$/i;
const NATURAL_RELATIVE_SINCE =
  /^(?:last\s+)?(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)$/i;
const SINCE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

export function resolveWikiSince(raw: string, now: number = Date.now()): Date {
  const trimmed = raw.trim();
  const relative = RELATIVE_SINCE.exec(trimmed) ?? NATURAL_RELATIVE_SINCE.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = SINCE_UNIT_MS[(relative[2] ?? "").toLowerCase()];
    if (!unitMs || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid "since" value: ${raw}`);
    }
    const timestamp = now - amount * unitMs;
    if (!Number.isFinite(timestamp)) throw new Error(`Invalid "since" value: ${raw}`);
    return new Date(timestamp);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`Invalid "since" value: ${raw}`);
  return new Date(parsed);
}
