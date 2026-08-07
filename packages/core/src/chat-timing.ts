export function formatGoatChatDuration(durationMs: number) {
  const safeDurationMs = Math.max(0, durationMs);
  const totalTenths = Math.round(safeDurationMs / 100);
  const totalSeconds = totalTenths / 10;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const seconds = totalSeconds - totalMinutes * 60;

  if (hours > 0) {
    return `${hours}h, ${minutes}m, ${seconds.toFixed(1)}s`;
  }
  if (totalMinutes > 0) {
    return `${totalMinutes}m, ${seconds.toFixed(1)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

export function finiteDurationMs(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
