import { createHash } from "node:crypto";
import {
  type NormalizedGranolaMeetingSourceItem,
  type NormalizedGranolaMeetingTranscriptSegment,
  normalizeEvidenceId,
  normalizeGoatBrainId,
} from "@opencompany/brain";
import {
  createGoatBrainMarkdownContent,
  goatBrainFilePathFor,
  MAX_GOAT_BRAIN_FILE_BYTES,
} from "@opencompany/db/brain-files";
import { truncateByBytes } from "./brain-jamie-writes";

export const GRANOLA_TRANSCRIPT_EXCERPT_BYTES = 400_000;
export const GRANOLA_EVIDENCE_FOLDER = "evidence/document";
export const GRANOLA_MEETING_FOLDER = "meetings";

export type GranolaMeetingIds = {
  meetingBrainId: string;
  evidenceBrainId: string;
};

// Deterministic ids: identical note payloads land on the same documents, so
// re-polls and job retries converge instead of duplicating pages.
export function buildGranolaMeetingIds(
  item: NormalizedGranolaMeetingSourceItem,
): GranolaMeetingIds {
  const meeting = item.content.meeting;
  const date = item.occurredAt.slice(0, 10);
  const titleSlug = (normalizeGoatBrainId(meeting.title) || "meeting").slice(0, 42);
  const meetingBrainId =
    normalizeGoatBrainId(`meeting-${date}-${titleSlug}-${shortHash(item.externalId)}`) ||
    `meeting-${shortHash(item.sourceRef)}`;
  const evidenceBrainId = normalizeEvidenceId(
    `ev-granola-${shortHash(`${item.externalId}:${item.contentHash}`, 18)}`,
  );
  if (!evidenceBrainId) throw new Error("Could not derive Granola evidence id.");
  return { meetingBrainId, evidenceBrainId };
}

export type GranolaMeetingEvidenceWrite = GranolaMeetingIds & {
  evidencePath: string;
  evidenceContent: string;
  truncatedTranscript: boolean;
};

export function buildGranolaMeetingEvidenceWrite(
  item: NormalizedGranolaMeetingSourceItem,
): GranolaMeetingEvidenceWrite {
  const meeting = item.content.meeting;
  const { meetingBrainId, evidenceBrainId } = buildGranolaMeetingIds(item);
  const source = granolaMeetingSource(item);
  const summaryMarkdown = truncateByBytes(meeting.summaryMarkdown, 120_000);
  const fullEvidenceContent = createEvidenceContent({
    item,
    meetingBrainId,
    evidenceBrainId,
    source,
    summaryMarkdown,
    transcriptMarkdown: formatGranolaTranscript(meeting.transcript),
    truncatedTranscript: false,
  });
  const truncatedTranscript =
    Buffer.byteLength(fullEvidenceContent, "utf8") > MAX_GOAT_BRAIN_FILE_BYTES;
  const evidenceContent = truncatedTranscript
    ? createEvidenceContent({
        item,
        meetingBrainId,
        evidenceBrainId,
        source,
        summaryMarkdown,
        transcriptMarkdown: formatGranolaTranscriptExcerpt(
          meeting.transcript,
          GRANOLA_TRANSCRIPT_EXCERPT_BYTES,
        ),
        truncatedTranscript: true,
      })
    : fullEvidenceContent;
  if (Buffer.byteLength(evidenceContent, "utf8") > MAX_GOAT_BRAIN_FILE_BYTES) {
    throw new Error("Granola evidence document exceeds the Goat Brain file size limit.");
  }

  return {
    meetingBrainId,
    evidenceBrainId,
    evidencePath: goatBrainFilePathFor(GRANOLA_EVIDENCE_FOLDER, evidenceBrainId),
    evidenceContent,
    truncatedTranscript,
  };
}

function granolaMeetingSource(item: NormalizedGranolaMeetingSourceItem) {
  return {
    ref: item.sourceRef,
    title: `Granola: ${item.content.meeting.title}`,
    capturedAt: item.capturedAt,
  };
}

function createEvidenceContent(input: {
  item: NormalizedGranolaMeetingSourceItem;
  meetingBrainId: string;
  evidenceBrainId: string;
  source: { ref: string; title: string; capturedAt: string };
  summaryMarkdown: string;
  transcriptMarkdown: string;
  truncatedTranscript: boolean;
}) {
  const meeting = input.item.content.meeting;
  const note = input.item.content.note;
  const compiledTruth = [
    "Granola meeting notes.",
    "## Meeting metadata",
    [
      `- Started: ${meeting.startTime}`,
      meeting.endTime ? `- Ended: ${meeting.endTime}` : null,
      note.webUrl ? `- Granola note: ${note.webUrl}` : null,
      `- Source: ${input.item.sourceRef}`,
    ]
      .filter(Boolean)
      .join("\n"),
    "## Summary",
    input.summaryMarkdown,
    "## Participants",
    formatGranolaParticipants(input.item),
    "## Transcript",
    input.truncatedTranscript
      ? [
          "The full raw Granola payload is stored on the source item. This evidence record contains a bounded transcript excerpt because the transcript exceeded the Brain file size limit.",
          input.transcriptMarkdown,
        ].join("\n\n")
      : input.transcriptMarkdown,
  ].join("\n\n");

  return createGoatBrainMarkdownContent({
    id: input.evidenceBrainId,
    folderPath: GRANOLA_EVIDENCE_FOLDER,
    title: `Granola notes: ${meeting.title}`,
    type: "meeting",
    status: "active",
    compiledTruth,
    related: [{ type: "about", to: input.meetingBrainId }],
    sources: [input.source],
  });
}

export function formatGranolaParticipants(item: NormalizedGranolaMeetingSourceItem) {
  const participants = item.content.meeting.participants;
  if (participants.length === 0) return "No participants listed by Granola.";
  return participants
    .map((participant) => {
      const label = participant.name ?? participant.email ?? "Unknown participant";
      const suffix = participant.email && participant.name ? ` (${participant.email})` : "";
      return `- ${label}${suffix}`;
    })
    .join("\n");
}

export function formatGranolaTranscript(
  segments: readonly NormalizedGranolaMeetingTranscriptSegment[],
) {
  if (segments.length === 0) return "No transcript provided by Granola.";
  return segments.map(formatGranolaTranscriptSegment).join("\n");
}

export function formatGranolaTranscriptExcerpt(
  segments: readonly NormalizedGranolaMeetingTranscriptSegment[],
  maxBytes: number,
) {
  const lines: string[] = [];
  let bytes = 0;
  for (const segment of segments) {
    const line = formatGranolaTranscriptSegment(segment);
    const nextBytes = bytes + Buffer.byteLength(`${line}\n`, "utf8");
    if (nextBytes > maxBytes) break;
    lines.push(line);
    bytes = nextBytes;
  }
  lines.push(
    `\nTranscript truncated after ${lines.length} of ${segments.length} Granola transcript segments.`,
  );
  return lines.join("\n");
}

function formatGranolaTranscriptSegment(segment: NormalizedGranolaMeetingTranscriptSegment) {
  const parts = [
    segment.startedAt ? `[${segment.startedAt}]` : null,
    segment.speaker ? `**${segment.speaker}:**` : null,
    segment.text,
  ].filter(Boolean);
  return `- ${parts.join(" ")}`;
}

function shortHash(value: string, length = 10) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}
