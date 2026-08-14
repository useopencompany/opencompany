import { createHash } from "node:crypto";
import {
  brainTimelineEntryFromParts,
  formatBrainEvidenceLink,
  type NormalizedJamieMeetingSourceItem,
  type NormalizedJamieMeetingTranscriptSegment,
  normalizeBrainId,
  normalizeEvidenceId,
} from "@opencompany/brain";
import {
  brainFilePathFor,
  createBrainMarkdownContent,
  MAX_BRAIN_FILE_BYTES,
} from "@opencompany/db/brain-files";

export const JAMIE_TRANSCRIPT_EXCERPT_BYTES = 400_000;
export const JAMIE_EVIDENCE_FOLDER = "evidence/document";
export const JAMIE_MEETING_FOLDER = "meetings";

export type JamieMeetingIds = {
  meetingBrainId: string;
  evidenceBrainId: string;
};

// Deterministic ids: identical webhook payloads land on the same documents, so
// re-delivery and job retries converge instead of duplicating pages.
export function buildJamieMeetingIds(item: NormalizedJamieMeetingSourceItem): JamieMeetingIds {
  const meeting = item.content.meeting;
  const date = item.occurredAt.slice(0, 10);
  const titleSlug = (normalizeBrainId(meeting.title) || "meeting").slice(0, 42);
  const meetingBrainId =
    normalizeBrainId(`meeting-${date}-${titleSlug}-${shortHash(item.externalId)}`) ||
    `meeting-${shortHash(item.sourceRef)}`;
  const evidenceBrainId = normalizeEvidenceId(
    `ev-jamie-${shortHash(`${item.externalId}:${item.contentHash}`, 18)}`,
  );
  if (!evidenceBrainId) throw new Error("Could not derive Jamie evidence id.");
  return { meetingBrainId, evidenceBrainId };
}

export type JamieMeetingEvidenceWrite = JamieMeetingIds & {
  evidencePath: string;
  evidenceContent: string;
  truncatedTranscript: boolean;
};

export function buildJamieMeetingEvidenceWrite(
  item: NormalizedJamieMeetingSourceItem,
): JamieMeetingEvidenceWrite {
  const meeting = item.content.meeting;
  const { meetingBrainId, evidenceBrainId } = buildJamieMeetingIds(item);
  const source = jamieMeetingSource(item);
  const summaryMarkdown = truncateByBytes(meeting.summaryMarkdown, 120_000);
  const fullEvidenceContent = createEvidenceContent({
    item,
    meetingBrainId,
    evidenceBrainId,
    source,
    summaryMarkdown,
    transcriptMarkdown: formatTranscript(meeting.transcript),
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
        transcriptMarkdown: formatTranscriptExcerpt(
          meeting.transcript,
          JAMIE_TRANSCRIPT_EXCERPT_BYTES,
        ),
        truncatedTranscript: true,
      })
    : fullEvidenceContent;
  if (Buffer.byteLength(evidenceContent, "utf8") > MAX_BRAIN_FILE_BYTES) {
    throw new Error("Jamie evidence document exceeds the opencompany Brain file size limit.");
  }

  return {
    meetingBrainId,
    evidenceBrainId,
    evidencePath: brainFilePathFor(JAMIE_EVIDENCE_FOLDER, evidenceBrainId),
    evidenceContent,
    truncatedTranscript,
  };
}

export function buildJamieMeetingBrainWrites(item: NormalizedJamieMeetingSourceItem) {
  const meeting = item.content.meeting;
  const evidence = buildJamieMeetingEvidenceWrite(item);
  const source = jamieMeetingSource(item);
  const summaryMarkdown = truncateByBytes(meeting.summaryMarkdown, 120_000);

  const evidenceLink = formatBrainEvidenceLink(evidence.evidenceBrainId, "Jamie meeting notes");
  const meetingCompiledTruth = [
    "Imported from Jamie.",
    "## Summary",
    summaryMarkdown,
    "## Participants",
    formatParticipants(item),
    "## Action items",
    formatActionItems(item),
    "## Evidence",
    `- ${evidenceLink}`,
  ].join("\n\n");

  const meetingContent = createBrainMarkdownContent({
    id: evidence.meetingBrainId,
    folderPath: JAMIE_MEETING_FOLDER,
    title: meeting.title,
    type: "meeting",
    status: "active",
    compiledTruth: meetingCompiledTruth,
    sources: [source],
    timeline: [
      brainTimelineEntryFromParts({
        evidenceId: evidence.evidenceBrainId,
        at: item.occurredAt,
        summary: `Jamie notes imported for ${meeting.title}.`,
        detail: "Summary, action items, participants, and transcript were imported from Jamie.",
        sourceRef: item.sourceRef,
        sourceTitle: `Jamie: ${meeting.title}`,
      }),
    ],
  });

  if (Buffer.byteLength(meetingContent, "utf8") > MAX_BRAIN_FILE_BYTES) {
    throw new Error("Jamie meeting document exceeds the opencompany Brain file size limit.");
  }

  return {
    meetingBrainId: evidence.meetingBrainId,
    evidenceBrainId: evidence.evidenceBrainId,
    meetingContent,
    evidenceContent: evidence.evidenceContent,
    truncatedTranscript: evidence.truncatedTranscript,
  };
}

function jamieMeetingSource(item: NormalizedJamieMeetingSourceItem) {
  return {
    ref: item.sourceRef,
    title: `Jamie: ${item.content.meeting.title}`,
    capturedAt: item.capturedAt,
  };
}

function createEvidenceContent(input: {
  item: NormalizedJamieMeetingSourceItem;
  meetingBrainId: string;
  evidenceBrainId: string;
  source: { ref: string; title: string; capturedAt: string };
  summaryMarkdown: string;
  transcriptMarkdown: string;
  truncatedTranscript: boolean;
}) {
  const meeting = input.item.content.meeting;
  const compiledTruth = [
    "Jamie meeting notes.",
    "## Meeting metadata",
    [
      `- Started: ${meeting.startTime}`,
      meeting.endTime ? `- Ended: ${meeting.endTime}` : null,
      `- Source: ${input.item.sourceRef}`,
    ]
      .filter(Boolean)
      .join("\n"),
    "## Summary",
    input.summaryMarkdown,
    "## Participants",
    formatParticipants(input.item),
    "## Action items",
    formatActionItems(input.item),
    "## Transcript",
    input.truncatedTranscript
      ? [
          "The full raw Jamie payload is stored on the source item. This evidence record contains a bounded transcript excerpt because the transcript exceeded the Brain file size limit.",
          input.transcriptMarkdown,
        ].join("\n\n")
      : input.transcriptMarkdown,
  ].join("\n\n");

  return createBrainMarkdownContent({
    id: input.evidenceBrainId,
    folderPath: JAMIE_EVIDENCE_FOLDER,
    title: `Jamie notes: ${meeting.title}`,
    type: "meeting",
    status: "active",
    compiledTruth,
    related: [{ type: "about", to: input.meetingBrainId }],
    sources: [input.source],
  });
}

export function formatParticipants(item: NormalizedJamieMeetingSourceItem) {
  const participants = item.content.meeting.participants;
  if (participants.length === 0) return "No participants listed by Jamie.";
  return participants
    .map((participant) => {
      const label =
        participant.name ?? participant.email ?? participant.id ?? "Unknown participant";
      const suffix = participant.email && participant.name ? ` (${participant.email})` : "";
      return `- ${label}${suffix}`;
    })
    .join("\n");
}

export function formatActionItems(item: NormalizedJamieMeetingSourceItem) {
  const actionItems = item.content.meeting.actionItems;
  if (actionItems.length === 0) return "No action items listed by Jamie.";
  return actionItems
    .map((action) => `- ${action.text}${action.assignee ? ` (${action.assignee})` : ""}`)
    .join("\n");
}

export function formatTranscript(segments: NormalizedJamieMeetingTranscriptSegment[]) {
  return segments.map(formatTranscriptSegment).join("\n");
}

export function formatTranscriptExcerpt(
  segments: NormalizedJamieMeetingTranscriptSegment[],
  maxBytes: number,
) {
  const lines: string[] = [];
  let bytes = 0;
  for (const segment of segments) {
    const line = formatTranscriptSegment(segment);
    const nextBytes = bytes + Buffer.byteLength(`${line}\n`, "utf8");
    if (nextBytes > maxBytes) break;
    lines.push(line);
    bytes = nextBytes;
  }
  lines.push(
    `\nTranscript truncated after ${lines.length} of ${segments.length} Jamie transcript segments.`,
  );
  return lines.join("\n");
}

function formatTranscriptSegment(segment: NormalizedJamieMeetingTranscriptSegment) {
  const parts = [
    segment.startedAt ? `[${segment.startedAt}]` : null,
    segment.speaker ? `**${segment.speaker}:**` : null,
    segment.text,
  ].filter(Boolean);
  return `- ${parts.join(" ")}`;
}

export function truncateByBytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  for (const char of value) {
    const next = `${output}${char}`;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    output = next;
  }
  return `${output}\n\n[Truncated to fit the opencompany Brain file size limit.]`;
}

function shortHash(value: string, length = 10) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}
