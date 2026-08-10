const FALLBACK_TIMEZONES = [
  "UTC",
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
];

export function supportedTimezones() {
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const values = new Set([...supported, ...FALLBACK_TIMEZONES].filter(isValidTimezone));
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function timezoneLabel(timezone: string, now = new Date()) {
  return `${timezone} (UTC${timezoneOffsetLabel(timezone, now)})`;
}

function timezoneOffsetLabel(timezone: string, now: Date) {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(now)
      .find((item) => item.type === "timeZoneName")?.value;
    return (part ?? "UTC").replace("UTC", "").replace("GMT", "") || "+0";
  } catch {
    return "+0";
  }
}

function isValidTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
