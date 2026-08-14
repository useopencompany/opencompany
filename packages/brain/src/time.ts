export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function isIsoDate(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}
