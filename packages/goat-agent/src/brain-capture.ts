import { captureGoatIngestionQuotaAnalytics } from "@opencompany/analytics/goat";
import {
  createGoatBrainMarkdownContent,
  goatBrainFilePathFor,
  upsertGoatBrainFile,
} from "@opencompany/db/goat-brain-files";
import {
  findExistingGoatBrainChatCaptureIngest,
  findExistingGoatBrainPointerIngest,
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
  GOAT_BRAIN_POINTER_HYDRATE_JOB_KIND,
  upsertGoatBrainSourceItemAndEnqueue,
} from "@opencompany/db/goat-brain-ingest";
import {
  isValidGoatBrainSourceRef,
  normalizeGoatBrainId,
  normalizeGoatBrainPointerCapture,
  normalizeGoatChatCapture,
  nowIso,
  parseGoatBrainSourceRef,
} from "@opencompany/goat-brain";

export const GOAT_BRAIN_CAPTURE_FOLDER = "inbox";
const CAPTURE_TITLE_MAX_LENGTH = 80;
const CAPTURE_TEXT_MAX_BYTES = 64_000;
const POINTER_FALLBACK_MAX_BYTES = 2_000;

export type GoatBrainCaptureResult =
  | {
      ok: true;
      draftBrainId: string;
      path: string;
      title: string;
      jobId: string | null;
      enqueued: boolean;
      alreadyCaptured?: boolean;
      quotaPaused?: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type GoatBrainCaptureSource =
  | { kind: "chat"; connectionId: string; itemId: string; idempotencyKey?: string }
  | { kind: "mcp"; connectionId: string; itemId: string };

export type GoatBrainCaptureDependencies = {
  nextAvailableBrainId: (brainRef: string, baseId: string) => Promise<string>;
  wakeIngest: () => Promise<unknown>;
};

// Explicit saves from Goat chat or MCP are capture-first: persist a draft page
// in inbox/ immediately so nothing is lost, then enqueue the durable ingestion
// agent to curate it (type, title, folder, links, promotion) in the background.
export async function captureToGoatBrainInbox(
  input: {
    brainRef: string;
    actorId: string;
    text?: string;
    title?: string;
    intent?: string;
    sourceRef?: string;
    integrationId?: string;
    fallbackText?: string;
    source: GoatBrainCaptureSource;
  },
  dependencies: GoatBrainCaptureDependencies,
): Promise<GoatBrainCaptureResult> {
  const text = input.text?.trim() ?? "";
  const fallbackText = input.fallbackText?.trim() ?? "";
  const sourceRef = input.sourceRef?.trim();
  if (sourceRef && !isValidGoatBrainSourceRef(sourceRef)) {
    return {
      ok: false,
      error: "Capture sourceRef must be a valid provider:id or URL.",
    };
  }
  const pointerProvider = sourceRef ? hydratablePointerProvider(sourceRef) : null;
  const isPointerCapture = !text && Boolean(pointerProvider);
  if (!text && !isPointerCapture) {
    return {
      ok: false,
      error: sourceRef
        ? "This source needs fallback content because its provider cannot be hydrated."
        : "Capture content must not be empty.",
    };
  }
  const integrationId = input.integrationId?.trim();
  if (isPointerCapture && !integrationId) {
    return {
      ok: false,
      error: "A bare integration source needs the integrationId returned by use_action.",
    };
  }
  if (text && Buffer.byteLength(text, "utf8") > CAPTURE_TEXT_MAX_BYTES) {
    return {
      ok: false,
      error: "Capture content is too large. Start a task for large documents.",
    };
  }
  if (fallbackText && Buffer.byteLength(fallbackText, "utf8") > POINTER_FALLBACK_MAX_BYTES) {
    return {
      ok: false,
      error: "Pointer fallback content must be 2 KB or smaller.",
    };
  }

  const idempotencyKey =
    input.source.kind === "chat" ? input.source.idempotencyKey?.trim() : undefined;
  if (!isPointerCapture && idempotencyKey) {
    const existing = await findExistingGoatBrainChatCaptureIngest({
      userWorkosId: input.actorId,
      sourceConnectionId: input.source.connectionId,
      externalId: idempotencyKey,
      brainRef: input.brainRef,
    });
    if (existing) {
      return {
        ok: true,
        draftBrainId: existing.draftBrainId,
        path: goatBrainFilePathFor(existing.draftFolder, existing.draftBrainId),
        title: existing.title,
        jobId: existing.jobId,
        enqueued: false,
        alreadyCaptured: true,
        quotaPaused: existing.planPaused,
      };
    }
  }

  if (isPointerCapture) {
    const existing = await findExistingGoatBrainPointerIngest({
      userWorkosId: input.actorId,
      integrationId: integrationId!,
      provider: pointerProvider!,
      sourceRef: sourceRef!,
      brainRef: input.brainRef,
    });
    if (existing) {
      return {
        ok: true,
        draftBrainId: existing.draftBrainId,
        path: goatBrainFilePathFor(existing.draftFolder, existing.draftBrainId),
        title: existing.title,
        jobId: existing.jobId,
        enqueued: false,
        alreadyCaptured: true,
        quotaPaused: existing.planPaused,
      };
    }
  }

  const capturedAt = nowIso();
  const title = input.title?.trim() || deriveCaptureTitle(text || sourceRef || "Saved source");
  const draftBrainId = await dependencies.nextAvailableBrainId(
    input.brainRef,
    normalizeGoatBrainId(title),
  );
  const resolvedSourceRef =
    sourceRef ?? `${input.source.kind === "mcp" ? "mcp" : "goat-chat"}:${input.source.itemId}`;
  const path = goatBrainFilePathFor(GOAT_BRAIN_CAPTURE_FOLDER, draftBrainId);
  await upsertGoatBrainFile({
    brainRef: input.brainRef,
    userWorkosId: input.actorId,
    path,
    content: createGoatBrainMarkdownContent({
      id: draftBrainId,
      folderPath: GOAT_BRAIN_CAPTURE_FOLDER,
      title,
      type: "note",
      status: "draft",
      compiledTruth:
        text || fallbackText || `Saved source: [[source:${resolvedSourceRef}|Original source]]`,
      sources: [
        {
          ref: resolvedSourceRef,
          title: sourceRef
            ? "Original source"
            : input.source.kind === "mcp"
              ? "MCP capture"
              : "Chat capture",
          capturedAt,
        },
      ],
    }),
  });

  const item = isPointerCapture
    ? normalizeGoatBrainPointerCapture({
        sourceRef: resolvedSourceRef,
        title,
        ...(fallbackText ? { fallbackText } : {}),
        chatSessionId: input.source.connectionId,
        userMessageId: input.source.itemId,
        draftBrainId,
        draftFolder: GOAT_BRAIN_CAPTURE_FOLDER,
        capturedAt,
      })
    : normalizeGoatChatCapture({
        text,
        title,
        ...(input.intent?.trim() ? { intent: input.intent.trim() } : {}),
        chatSessionId: input.source.connectionId,
        userMessageId: input.source.itemId,
        draftBrainId,
        draftFolder: GOAT_BRAIN_CAPTURE_FOLDER,
        capturedAt,
        sourceRef: resolvedSourceRef,
        ...(idempotencyKey ? { externalId: idempotencyKey } : {}),
      });
  const result = await upsertGoatBrainSourceItemAndEnqueue({
    userWorkosId: input.actorId,
    sourceConnectionId: isPointerCapture ? integrationId! : input.source.connectionId,
    ...(isPointerCapture ? { integrationId: integrationId! } : {}),
    item,
    rawPayload: item.content,
    kind: isPointerCapture ? GOAT_BRAIN_POINTER_HYDRATE_JOB_KIND : GOAT_BRAIN_AGENT_INGEST_JOB_KIND,
    brainRef: input.brainRef,
  });
  captureGoatIngestionQuotaAnalytics(result.quotaUpdates);

  if (result.enqueued) {
    dependencies.wakeIngest().catch((error) => {
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

function hydratablePointerProvider(sourceRef: string) {
  const provider = parseGoatBrainSourceRef(sourceRef)?.provider;
  return provider === "slack" || provider === "gmail" || provider === "linear" ? provider : null;
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
