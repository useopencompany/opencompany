export const GOAT_HOME_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function homeActivityCutoff(now = Date.now()) {
  return new Date(now - GOAT_HOME_ACTIVITY_WINDOW_MS);
}

export function isRecentHomeActivity(value: string | Date | null | undefined, now = Date.now()) {
  if (!value) return false;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= now - GOAT_HOME_ACTIVITY_WINDOW_MS;
}
