import { createHash } from "node:crypto";
import {
  type NormalizedFathomMeetingSourceItem,
  type NormalizedFathomMeetingTranscriptSegment,
  normalizeBrainId,
  normalizeEvidenceId,
} from "@opencompany/brain";
import {
  brainFilePathFor,
  createBrainMarkdownContent,
  MAX_BRAIN_FILE_BYTES,
} from "@opencompany/db/brain-files";
import { truncateByBytes } from "./brain-jamie-writes";

export const FATHOM_TRANSCRIPT_EXCERPT_BYTES = 400_000;
export const FATHOM_EVIDENCE_FOLDER = "evidence/document";
export const FATHOM_MEETING_FOLDER = "meetings";

export type FathomMeetingIds = {
  meetingBrainId: string;
  evidenceBrainId: string;
};

// Deterministic ids: identical meeting payloads land on the same documents, so
// re-polls and job retries converge instead of duplicating pages.
export function buildFathomMeetingIds(item: NormalizedFathomMeetingSourceItem): FathomMeetingIds {
  const meeting = item.content.meeting;
  const date = item.occurredAt.slice(0, 10);
  const titleSlug = (normalizeBrainId(meeting.title) || "meeting").slice(0, 42);
  const meetingBrainId =
    normalizeBrainId(`meeting-${date}-${titleSlug}-${shortHash(item.externalId)}`) ||
    `meeting-${shortHash(item.sourceRef)}`;
  const evidenceBrainId = normalizeEvidenceId(
    `ev-fathom-${shortHash(`${item.externalId}:${item.contentHash}`, 18)}`,
  );
  if (!evidenceBrainId) throw new Error("Could not derive Fathom evidence id.");
  return { meetingBrainId, evidenceBrainId };
}

export type FathomMeetingEvidenceWrite = FathomMeetingIds & {
  evidencePath: string;
  evidenceContent: string;
  truncatedTranscript: boolean;
};

export function buildFathomMeetingEvidenceWrite(
  item: NormalizedFathomMeetingSourceItem,
): FathomMeetingEvidenceWrite {
  const meeting = item.content.meeting;
  const { meetingBrainId, evidenceBrainId } = buildFathomMeetingIds(item);
  const source = fathomMeetingSource(item);
  const summaryMarkdown = truncateByBytes(meeting.summaryMarkdown, 120_000);
  const fullEvidenceContent = createEvidenceContent({
    item,
    meetingBrainId,
    evidenceBrainId,
    source,
    summaryMarkdown,
    transcriptMarkdown: formatFathomTranscript(meeting.transcript),
    truncatedTranscript: false,
  });
  const truncatedTranscript = Buffer.byteLength(fullEvidenceContent, "utf8") > MAX_BRAIN_FILE_BYTES;
  const evidenceContent = truncatedTranscript
    ? createEvidenceContent({
        item,
        meetingBrainId,
        evidenceBrainId,
        source,
        summaryMarkdown,
        transcriptMarkdown: formatFathomTranscriptExcerpt(
          meeting.transcript,
          FATHOM_TRANSCRIPT_EXCERPT_BYTES,
        ),
        truncatedTranscript: true,
      })
    : fullEvidenceContent;
  if (Buffer.byteLength(evidenceContent, "utf8") > MAX_BRAIN_FILE_BYTES) {
    throw new Error("Fathom evidence document exceeds the Goat Brain file size limit.");
  }

  return {
    meetingBrainId,
    evidenceBrainId,
    evidencePath: brainFilePathFor(FATHOM_EVIDENCE_FOLDER, evidenceBrainId),
    evidenceContent,
    truncatedTranscript,
  };
}

function fathomMeetingSource(item: NormalizedFathomMeetingSourceItem) {
  return {
    ref: item.sourceRef,
    title: `Fathom: ${item.content.meeting.title}`,
    capturedAt: item.capturedAt,
  };
}

function createEvidenceContent(input: {
  item: NormalizedFathomMeetingSourceItem;
  meetingBrainId: string;
  evidenceBrainId: string;
  source: { ref: string; title: string; capturedAt: string };
  summaryMarkdown: string;
  transcriptMarkdown: string;
  truncatedTranscript: boolean;
}) {
  const meeting = input.item.content.meeting;
  const recording = input.item.content.recording;
  const compiledTruth = [
    "Fathom meeting notes.",
    "## Meeting metadata",
    [
      `- Started: ${meeting.startTime}`,
      meeting.endTime ? `- Ended: ${meeting.endTime}` : null,
      recording.shareUrl ? `- Fathom recording: ${recording.shareUrl}` : null,
      `- Source: ${input.item.sourceRef}`,
    ]
      .filter(Boolean)
      .join("\n"),
    "## Summary",
    input.summaryMarkdown || "No summary provided by Fathom.",
    "## Action items",
    formatFathomActionItems(input.item),
    "## Participants",
    formatFathomParticipants(input.item),
    "## Transcript",
    input.truncatedTranscript
      ? [
          "The full raw Fathom payload is stored on the source item. This evidence record contains a bounded transcript excerpt because the transcript exceeded the Brain file size limit.",
          input.transcriptMarkdown,
        ].join("\n\n")
      : input.transcriptMarkdown,
  ].join("\n\n");

  return createBrainMarkdownContent({
    id: input.evidenceBrainId,
    folderPath: FATHOM_EVIDENCE_FOLDER,
    title: `Fathom notes: ${meeting.title}`,
    type: "meeting",
    status: "active",
    compiledTruth,
    related: [{ type: "about", to: input.meetingBrainId }],
    sources: [input.source],
  });
}

export function formatFathomParticipants(item: NormalizedFathomMeetingSourceItem) {
  const participants = item.content.meeting.participants;
  if (participants.length === 0) return "No participants listed by Fathom.";
  return participants
    .map((participant) => {
      const label = participant.name ?? participant.email ?? "Unknown participant";
      const suffix = participant.email && participant.name ? ` (${participant.email})` : "";
      return `- ${label}${suffix}`;
    })
    .join("\n");
}

export function formatFathomActionItems(item: NormalizedFathomMeetingSourceItem) {
  const actionItems = item.content.meeting.actionItems;
  if (actionItems.length === 0) return "No action items listed by Fathom.";
  return actionItems
    .map((actionItem) => {
      const parts = [
        actionItem.completed ? "[done]" : null,
        actionItem.description,
        actionItem.assignee ? `— ${actionItem.assignee}` : null,
      ].filter(Boolean);
      return `- ${parts.join(" ")}`;
    })
    .join("\n");
}

export function formatFathomTranscript(
  segments: readonly NormalizedFathomMeetingTranscriptSegment[],
) {
  if (segments.length === 0) return "No transcript provided by Fathom.";
  return segments.map(formatFathomTranscriptSegment).join("\n");
}

export function formatFathomTranscriptExcerpt(
  segments: readonly NormalizedFathomMeetingTranscriptSegment[],
  maxBytes: number,
) {
  const lines: string[] = [];
  let bytes = 0;
  for (const segment of segments) {
    const line = formatFathomTranscriptSegment(segment);
    const nextBytes = bytes + Buffer.byteLength(`${line}\n`, "utf8");
    if (nextBytes > maxBytes) break;
    lines.push(line);
    bytes = nextBytes;
  }
  lines.push(
    `\nTranscript truncated after ${lines.length} of ${segments.length} Fathom transcript segments.`,
  );
  return lines.join("\n");
}

function formatFathomTranscriptSegment(segment: NormalizedFathomMeetingTranscriptSegment) {
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
