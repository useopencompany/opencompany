export type UserTimezoneSource = "unset" | "browser" | "manual";

export const DEFAULT_USER_TIMEZONE = "UTC";

export const COMMON_TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

const FALLBACK_TIMEZONES = [
  DEFAULT_USER_TIMEZONE,
  ...COMMON_TIMEZONES,
  "America/Anchorage",
  "America/Honolulu",
  "America/Mexico_City",
  "America/Phoenix",
  "America/Toronto",
  "America/Vancouver",
  "Europe/Amsterdam",
  "Europe/Dublin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Stockholm",
  "Asia/Bangkok",
  "Asia/Hong_Kong",
  "Asia/Seoul",
  "Pacific/Auckland",
];

export function supportedTimezones() {
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return uniqueSorted([DEFAULT_USER_TIMEZONE, ...supported, ...FALLBACK_TIMEZONES]);
}

export function normalizeUserTimezone(value: string | null | undefined) {
  const timezone = value?.trim() || DEFAULT_USER_TIMEZONE;
  return isValidTimezone(timezone) ? timezone : null;
}

export function normalizeUserTimezoneSource(value: string | null | undefined): UserTimezoneSource {
  return value === "browser" || value === "manual" ? value : "unset";
}

export function browserTimezone() {
  if (typeof window === "undefined") return null;
  return normalizeUserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

export function timezoneLabel(timezone: string, now = new Date()) {
  return `${timezone} (${timezoneOffsetLabel(timezone, now)})`;
}

export function timezoneOffsetLabel(timezone: string, now = new Date()) {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(now)
      .find((item) => item.type === "timeZoneName")?.value;
    return part ?? "UTC";
  } catch {
    return "UTC";
  }
}

export function timezoneSearchLabel(timezone: string) {
  return timezone.replace(/[_/]/g, " ");
}

function isValidTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter(isValidTimezone))].sort((left, right) =>
    left.localeCompare(right),
  );
}
