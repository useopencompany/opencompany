import type { BrowserToolName } from "./names";

const BROWSER_MODEL_SINGLE_OUTPUT_LIMIT = 12_000;
const BROWSER_MODEL_CUMULATIVE_OUTPUT_LIMIT = 40_000;
const BROWSER_MODEL_SNAPSHOT_LIMIT = 6;

export type BrowserObservationBudget = {
  cumulativeOutputChars: number;
  largestOutputChars: number;
  snapshotCount: number;
};

export function createBrowserObservationBudget(): BrowserObservationBudget {
  return {
    cumulativeOutputChars: 0,
    largestOutputChars: 0,
    snapshotCount: 0,
  };
}

export function modelFacingBrowserOutput(input: {
  name: BrowserToolName;
  output: unknown;
  budget: BrowserObservationBudget;
}) {
  const record = asRecord(input.output);
  const text = typeof record.output === "string" ? record.output : "";
  if (!text) return input.output;

  const outputChars = text.length;
  input.budget.cumulativeOutputChars += outputChars;
  input.budget.largestOutputChars = Math.max(input.budget.largestOutputChars, outputChars);
  if (input.name === "browser_snapshot") input.budget.snapshotCount += 1;

  if (!shouldCompactBrowserOutput(input.name, outputChars, input.budget)) return input.output;

  return {
    ...record,
    output: compactBrowserObservation(text),
    compacted: true,
    originalOutputChars: outputChars,
    browserObservationBudget: {
      cumulativeOutputChars: input.budget.cumulativeOutputChars,
      largestOutputChars: input.budget.largestOutputChars,
      snapshotCount: input.budget.snapshotCount,
      maxSingleOutputChars: BROWSER_MODEL_SINGLE_OUTPUT_LIMIT,
      maxCumulativeOutputChars: BROWSER_MODEL_CUMULATIVE_OUTPUT_LIMIT,
      maxSnapshots: BROWSER_MODEL_SNAPSHOT_LIMIT,
    },
  };
}

export function compactBrowserObservation(value: string) {
  const lines = value.split("\n");
  const headerLines = lines
    .filter((line) => /^--- AGENT_BROWSER_PAGE_CONTENT|^Page:|^URL:/.test(line))
    .slice(0, 6);
  const refLines = lines.filter((line) => /\bref=e\d+\]|@e\d+\b/.test(line)).slice(0, 140);
  const otherLines = lines
    .filter((line) => line.trim() && !/\bref=e\d+\]|@e\d+\b/.test(line))
    .slice(0, 40);
  const body = [...headerLines, ...refLines, ...otherLines].join("\n");
  return [
    body ? truncate(body, BROWSER_MODEL_SINGLE_OUTPUT_LIMIT - 700) : "",
    "",
    "[Browser output compacted for model context. Use browser_get, browser_find, browser_read with filter, or browser_snapshot with selector/depth for targeted follow-up.]",
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldCompactBrowserOutput(
  name: BrowserToolName,
  outputChars: number,
  budget: BrowserObservationBudget,
) {
  if (!["browser_snapshot", "browser_read", "browser_get", "browser_find"].includes(name)) {
    return false;
  }
  return (
    outputChars > BROWSER_MODEL_SINGLE_OUTPUT_LIMIT ||
    budget.cumulativeOutputChars > BROWSER_MODEL_CUMULATIVE_OUTPUT_LIMIT ||
    budget.snapshotCount > BROWSER_MODEL_SNAPSHOT_LIMIT
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
