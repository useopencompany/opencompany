// Single source of "now" for the memory system, normalized to ISO-8601 UTC with seconds
// (the timestamp format every record and timeline entry uses). Centralized so tests can stub
// it and so the format never drifts between commands.
export function nowIso(date: Date = new Date()): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
