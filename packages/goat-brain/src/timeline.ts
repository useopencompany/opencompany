import { createHash } from "node:crypto";
import type { GoatBrainTimelineEntry } from "./schema";
import { isValidGoatBrainEvidenceId, normalizeGoatBrainId } from "./schema";

export type GoatBrainTimelineParts = {
  at: string;
  summary: string;
  detail: string;
  sourceRef: string;
  sourceTitle: string;
};

const SOURCE_PREFIX = "Source:";

export function goatBrainTimelineEntryFromParts(input: {
  evidenceId?: string | null;
  at: string;
  summary: string;
  detail?: string | null;
  sourceRef?: string | null;
  sourceTitle?: string | null;
}): GoatBrainTimelineEntry {
  const evidenceId =
    normalizeEvidenceId(input.evidenceId) ??
    deterministicEvidenceId({
      at: input.at,
      summary: input.summary,
      sourceRef: input.sourceRef ?? "",
    });
  return {
    evidenceId,
    at: input.at,
    body: goatBrainTimelineBody({
      summary: input.summary,
      detail: input.detail ?? "",
      sourceRef: input.sourceRef ?? "",
      sourceTitle: input.sourceTitle ?? "",
    }),
  };
}

export function goatBrainTimelineBody(input: {
  summary: string;
  detail?: string | null;
  sourceRef?: string | null;
  sourceTitle?: string | null;
}) {
  const sourceRef = input.sourceRef?.trim() ?? "";
  const sourceTitle = input.sourceTitle?.trim() ?? "";
  return [
    input.summary.trim(),
    input.detail?.trim() ?? "",
    sourceRef
      ? `${SOURCE_PREFIX} ${sourceTitle ? `${sourceTitle} (${sourceRef})` : sourceRef}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function goatBrainTimelinePartsFromEntry(
  entry: GoatBrainTimelineEntry,
): GoatBrainTimelineParts | null {
  const at = normalizeTimelineAt(entry.at);
  if (!at) return null;

  const chunks = entry.body
    .split(/\n\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  if (chunks.length === 0) return null;

  let sourceRef = "";
  let sourceTitle = "";
  const last = chunks[chunks.length - 1] ?? "";
  if (last.startsWith(SOURCE_PREFIX)) {
    const parsed = parseSourceLine(last.slice(SOURCE_PREFIX.length).trim());
    sourceRef = parsed.sourceRef;
    sourceTitle = parsed.sourceTitle;
    chunks.pop();
  }

  const summary = chunks.shift()?.trim() ?? "";
  if (!summary) return null;

  return {
    at,
    summary,
    detail: chunks.join("\n\n").trim(),
    sourceRef,
    sourceTitle,
  };
}

export function normalizeTimelineAt(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function normalizeEvidenceId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (isValidGoatBrainEvidenceId(trimmed)) return trimmed;
  const normalized = normalizeGoatBrainId(String(trimmed).replace(/^ev[-_]?/i, ""));
  const candidate = normalized ? `ev-${normalized}` : "";
  return isValidGoatBrainEvidenceId(candidate) ? candidate : null;
}

export function deterministicEvidenceId(input: {
  at: string;
  summary?: string | null;
  sourceRef?: string | null;
}): string {
  const normalizedAt = normalizeTimelineAt(input.at) ?? input.at;
  const dateSlug = normalizedAt.slice(0, 10).replace(/-/g, "");
  const label = normalizeGoatBrainId(input.sourceRef || input.summary || "evidence") || "evidence";
  const digest = createHash("sha256")
    .update([normalizedAt, input.sourceRef ?? "", input.summary ?? ""].join("\n"))
    .digest("hex")
    .slice(0, 8);
  const maxLabelLength = 76 - dateSlug.length - digest.length - 2;
  return (
    normalizeEvidenceId(`ev-${dateSlug}-${label.slice(0, maxLabelLength)}-${digest}`) ??
    "ev-evidence"
  );
}

function parseSourceLine(value: string) {
  const titled = /^(.*?)\s+\((.*)\)$/.exec(value);
  if (titled?.[1] && titled[2]) {
    return {
      sourceTitle: titled[1].trim(),
      sourceRef: titled[2].trim(),
    };
  }
  return {
    sourceTitle: "",
    sourceRef: value.trim(),
  };
}
