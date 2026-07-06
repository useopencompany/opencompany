import type { GoatTaskStage, GoatTaskStatus } from "@opencompany/db/goat-schema";

export const GOAT_STAGE_COPY: Record<GoatTaskStage, string> = {
  queued: "Waiting for runner",
  planning: "Planning task",
  sandboxing: "Preparing task",
  running: "Running task",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export const GOAT_STATUS_COPY: Record<GoatTaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

export function toGoatTaskTitle(text: string): string {
  const trimmed = text.trim().replace(/[.!]+$/, "");
  const clipped = trimmed.length > 64 ? `${trimmed.slice(0, 64).trimEnd()}...` : trimmed;
  return clipped.charAt(0).toUpperCase() + clipped.slice(1);
}

export function normalizeGoatTaskName(input: unknown, fallbackPrompt: string): string {
  if (typeof input === "string" && input.trim()) {
    return toGoatTaskName(input);
  }
  return toGoatTaskName(fallbackPrompt);
}

export function toGoatTaskName(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "Untitled task";
  const cleaned = firstLine
    .replace(/^(please\s+)?(can|could|would)\s+you\s+/i, "")
    .replace(/^(please\s+)?(help me|i need you to|i want you to)\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 7).join(" ");
  const clipped = words.length > 48 ? `${words.slice(0, 48).trimEnd()}...` : words;
  const fallback = clipped || "Untitled task";
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

export function formatGoatStartedAt(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
