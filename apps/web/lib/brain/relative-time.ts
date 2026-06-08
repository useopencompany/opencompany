const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Compact "time ago" label for Brain file update timestamps. The exact date is
// always available via the tooltip, so this stays relative all the way up to
// years rather than falling back to an absolute date.
export function formatBrainRelativeTime(value: string, now: Date = new Date()): string {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return "unknown";

  const seconds = Math.round((now.getTime() - ms) / 1000);

  // Clock skew / future timestamps read as just now rather than "in 3 minutes".
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 minute ago";

  const minutes = Math.round(seconds / MINUTE);
  if (minutes < 45) return `${minutes} minutes ago`;
  if (minutes < 90) return "1 hour ago";

  const hours = Math.round(seconds / HOUR);
  if (hours < 24) return `${hours} hours ago`;
  if (hours < 36) return "1 day ago";

  const days = Math.round(seconds / DAY);
  if (days < 30) return `${days} days ago`;

  const months = Math.round(days / 30);
  if (months < 12) return months <= 1 ? "1 month ago" : `${months} months ago`;

  const years = Math.round(days / 365);
  return years <= 1 ? "1 year ago" : `${years} years ago`;
}
