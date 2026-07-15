import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import {
  createGoatBrainMarkdownContent,
  goatBrainFilePathFor,
  upsertGoatBrainFile,
} from "@opencompany/db/goat-brain-files";
import {
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import { normalizeGoatBrainId, normalizeGoatChatCapture, nowIso } from "@opencompany/goat-brain";
import { nextAvailableGoatBrainId } from "@/lib/brain";
import { triggerGoatBrainIngestWake } from "@/lib/task-runner";

export const GOAT_BRAIN_CAPTURE_FOLDER = "inbox";
const CAPTURE_TITLE_MAX_LENGTH = 80;
const CAPTURE_TEXT_MAX_BYTES = 64_000;

export type GoatBrainCaptureResult =
  | {
      ok: true;
      draftBrainId: string;
      path: string;
      title: string;
      jobId: string | null;
      enqueued: boolean;
      quotaPaused?: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type GoatBrainCaptureSource =
  | { kind: "chat"; connectionId: string; itemId: string }
  | { kind: "mcp"; connectionId: string; itemId: string };

// Explicit saves from Goat chat or MCP are capture-first: persist a draft page
// in inbox/ immediately so nothing is lost, then enqueue the durable ingestion
// agent to curate it (type, title, folder, links, promotion) in the background.
export async function captureToGoatBrainInbox(input: {
  brainRef: string;
  userWorkosId: string;
  text: string;
  title?: string;
  intent?: string;
  source: GoatBrainCaptureSource;
}): Promise<GoatBrainCaptureResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, error: "Capture content must not be empty." };
  if (Buffer.byteLength(text, "utf8") > CAPTURE_TEXT_MAX_BYTES) {
    return {
      ok: false,
      error: "Capture content is too large. Start a task for large documents.",
    };
  }

  const capturedAt = nowIso();
  const title = input.title?.trim() || deriveCaptureTitle(text);
  const draftBrainId = await nextAvailableGoatBrainId(input.brainRef, normalizeGoatBrainId(title));
  const sourceRef = `${input.source.kind === "mcp" ? "mcp" : "goat-chat"}:${input.source.itemId}`;
  const path = goatBrainFilePathFor(GOAT_BRAIN_CAPTURE_FOLDER, draftBrainId);
  await upsertGoatBrainFile({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    path,
    content: createGoatBrainMarkdownContent({
      id: draftBrainId,
      folderPath: GOAT_BRAIN_CAPTURE_FOLDER,
      title,
      type: "note",
      status: "draft",
      compiledTruth: text,
      sources: [
        {
          ref: sourceRef,
          title: input.source.kind === "mcp" ? "MCP capture" : "Chat capture",
          capturedAt,
        },
      ],
    }),
  });

  const item = normalizeGoatChatCapture({
    text,
    title,
    ...(input.intent?.trim() ? { intent: input.intent.trim() } : {}),
    chatSessionId: input.source.connectionId,
    userMessageId: input.source.itemId,
    draftBrainId,
    draftFolder: GOAT_BRAIN_CAPTURE_FOLDER,
    capturedAt,
    sourceRef,
  });
  const result = await upsertGoatBrainSourceItemAndEnqueue({
    userWorkosId: input.userWorkosId,
    sourceConnectionId: input.source.connectionId,
    item,
    rawPayload: item.content,
    kind: GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
    brainRef: input.brainRef,
  });
  captureGoatIngestionQuotaAnalytics(result.quotaUpdates);

  if (result.enqueued) {
    triggerGoatBrainIngestWake().catch((error) => {
      console.warn("Goat Brain capture failed to wake the ingest worker.", {
        event: "goat.brain_capture_wake_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    ok: true,
    draftBrainId,
    path,
    title,
    jobId: result.jobId,
    enqueued: result.enqueued,
    quotaPaused: Boolean(result.paused),
  };
}

export function deriveCaptureTitle(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((line) =>
        line
          .replace(/^[#>\s*-]+/, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((line) => line.length > 0) ?? "";
  if (!firstLine) return "Chat capture";
  if (firstLine.length <= CAPTURE_TITLE_MAX_LENGTH) return firstLine;
  const cut = firstLine.slice(0, CAPTURE_TITLE_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
}
