import { createHash } from "node:crypto";
import {
  type NormalizedGmailThreadMessage,
  type NormalizedGmailThreadSourceItem,
  normalizeEvidenceId,
} from "@opencompany/brain";
import {
  brainFilePathFor,
  createBrainMarkdownContent,
  MAX_BRAIN_FILE_BYTES,
} from "@opencompany/db/brain-files";
import { truncateByBytes } from "./brain-jamie-writes";

export const GMAIL_EVIDENCE_FOLDER = "evidence/email";

export type GmailThreadEvidenceWrite = {
  evidenceBrainId: string;
  evidencePath: string;
  evidenceContent: string;
  truncatedBodies: boolean;
};

// Deterministic id: the same persisted window item lands on the same evidence
// document, so job retries converge instead of duplicating records. (A later
// window on the same thread has a different content hash and gets its own.)
export function buildGmailThreadEvidenceId(item: NormalizedGmailThreadSourceItem) {
  const evidenceBrainId = normalizeEvidenceId(
    `ev-gmail-${shortHash(`${item.content.thread.threadId}:${item.contentHash}`, 18)}`,
  );
  if (!evidenceBrainId) throw new Error("Could not derive Gmail evidence id.");
  return evidenceBrainId;
}

// Per the pointer-copy rule, emails snapshot into evidence/. The snapshot is
// written deterministically before the agent runs: evidence is the dump, and
// full message bodies should not round-trip through model tool calls.
export function buildGmailThreadEvidenceWrite(
  item: NormalizedGmailThreadSourceItem,
): GmailThreadEvidenceWrite {
  const evidenceBrainId = buildGmailThreadEvidenceId(item);
  const fullContent = createGmailEvidenceContent({ item, evidenceBrainId, truncatedBodies: false });
  const truncatedBodies = Buffer.byteLength(fullContent, "utf8") > MAX_BRAIN_FILE_BYTES;
  const evidenceContent = truncatedBodies
    ? createGmailEvidenceContent({ item, evidenceBrainId, truncatedBodies: true })
    : fullContent;
  if (Buffer.byteLength(evidenceContent, "utf8") > MAX_BRAIN_FILE_BYTES) {
    throw new Error("Gmail evidence document exceeds the Goat Brain file size limit.");
  }

  return {
    evidenceBrainId,
    evidencePath: brainFilePathFor(GMAIL_EVIDENCE_FOLDER, evidenceBrainId),
    evidenceContent,
    truncatedBodies,
  };
}

function createGmailEvidenceContent(input: {
  item: NormalizedGmailThreadSourceItem;
  evidenceBrainId: string;
  truncatedBodies: boolean;
}) {
  const thread = input.item.content.thread;
  // Leave generous headroom under the file cap for metadata when bodies are
  // truncated: split the budget evenly across messages.
  const perMessageBudget = input.truncatedBodies
    ? Math.max(2_000, Math.floor((MAX_BRAIN_FILE_BYTES * 0.8) / thread.messages.length))
    : Number.POSITIVE_INFINITY;

  const compiledTruth = [
    "Email thread snapshot from Gmail.",
    "## Thread metadata",
    [
      `- Subject: ${thread.subject}`,
      thread.accountEmail ? `- Mailbox: ${thread.accountEmail}` : null,
      `- Participants: ${thread.participants.join("; ") || "unknown"}`,
      `- Window: ${thread.windowStart} to ${thread.windowEnd}`,
      `- Source: ${input.item.sourceRef}`,
      thread.snapshotStale
        ? "- Note: the live thread could not be fetched; bodies below are snippets from buffered metadata."
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    "## Messages",
    thread.messages
      .map((message) => formatGmailEvidenceMessage(message, perMessageBudget))
      .join("\n\n---\n\n"),
    input.truncatedBodies
      ? "Some message bodies above were truncated to fit the Brain file size limit; the full normalized payload is stored on the source item."
      : null,
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");

  return createBrainMarkdownContent({
    id: input.evidenceBrainId,
    folderPath: GMAIL_EVIDENCE_FOLDER,
    title: `Email: ${thread.subject}`,
    type: "source",
    status: "active",
    compiledTruth,
    sources: [
      {
        ref: input.item.sourceRef,
        title: `Gmail: ${thread.subject}`,
        capturedAt: input.item.capturedAt,
      },
    ],
  });
}

function formatGmailEvidenceMessage(message: NormalizedGmailThreadMessage, maxBodyBytes: number) {
  const header = [
    `### ${message.direction === "sent" ? "Sent" : "Received"} ${message.sentAt}`,
    `- From: ${message.from}`,
    message.to ? `- To: ${message.to}` : null,
    message.cc ? `- Cc: ${message.cc}` : null,
    `- Message id: ${message.messageId} (source ref gmail:message:${message.messageId})`,
  ]
    .filter(Boolean)
    .join("\n");
  const body = message.bodyText.trim() || message.snippet || "(no text body)";
  const bounded = Number.isFinite(maxBodyBytes) ? truncateByBytes(body, maxBodyBytes) : body;
  return `${header}\n\n${bounded}`;
}

function shortHash(value: string, length = 10) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}
