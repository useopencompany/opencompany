import { captureProductIngestionQuotaAnalytics } from "@opencompany/analytics/product";
import {
  isValidBrainSourceRef,
  normalizeBrainId,
  normalizeBrainPointerCapture,
  normalizeChatCapture,
  nowIso,
  parseBrainSourceRef,
} from "@opencompany/brain";
import {
  brainFilePathFor,
  createBrainMarkdownContent,
  upsertBrainFile,
} from "@opencompany/db/brain-files";
import {
  BRAIN_AGENT_INGEST_JOB_KIND,
  BRAIN_POINTER_HYDRATE_JOB_KIND,
  findExistingBrainChatCaptureIngest,
  findExistingBrainPointerIngest,
  upsertBrainSourceItemAndEnqueue,
} from "@opencompany/db/brain-ingest";

export const BRAIN_CAPTURE_FOLDER = "inbox";
const CAPTURE_TITLE_MAX_LENGTH = 80;
const CAPTURE_TEXT_MAX_BYTES = 64_000;
const POINTER_FALLBACK_MAX_BYTES = 2_000;

export type BrainCaptureResult =
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

export type BrainCaptureSource =
  | { kind: "chat"; connectionId: string; itemId: string; idempotencyKey?: string }
  | { kind: "mcp"; connectionId: string; itemId: string };

export type BrainCaptureDependencies = {
  nextAvailableBrainId: (brainRef: string, baseId: string) => Promise<string>;
  wakeIngest?: () => Promise<unknown>;
};

// Explicit saves from opencompany chat or MCP are capture-first: persist a draft page
// in inbox/ immediately so nothing is lost, then enqueue the durable ingestion
// agent to curate it (type, title, folder, links, promotion) in the background.
export async function captureToBrainInbox(
  input: {
    brainRef: string;
    actorId: string;
    text?: string;
    title?: string;
    intent?: string;
    sourceRef?: string;
    integrationId?: string;
    fallbackText?: string;
    source: BrainCaptureSource;
  },
  dependencies: BrainCaptureDependencies,
): Promise<BrainCaptureResult> {
  const text = input.text?.trim() ?? "";
  const fallbackText = input.fallbackText?.trim() ?? "";
  const sourceRef = input.sourceRef?.trim();
  if (sourceRef && !isValidBrainSourceRef(sourceRef)) {
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
    const existing = await findExistingBrainChatCaptureIngest({
      userWorkosId: input.actorId,
      sourceConnectionId: input.source.connectionId,
      externalId: idempotencyKey,
      brainRef: input.brainRef,
    });
    if (existing) {
      return {
        ok: true,
        draftBrainId: existing.draftBrainId,
        path: brainFilePathFor(existing.draftFolder, existing.draftBrainId),
        title: existing.title,
        jobId: existing.jobId,
        enqueued: false,
        alreadyCaptured: true,
        quotaPaused: existing.planPaused,
      };
    }
  }

  if (isPointerCapture) {
    const existing = await findExistingBrainPointerIngest({
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
        path: brainFilePathFor(existing.draftFolder, existing.draftBrainId),
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
    normalizeBrainId(title),
  );
  const resolvedSourceRef =
    sourceRef ?? `${input.source.kind === "mcp" ? "mcp" : "goat-chat"}:${input.source.itemId}`;
  const path = brainFilePathFor(BRAIN_CAPTURE_FOLDER, draftBrainId);
  await upsertBrainFile({
    brainRef: input.brainRef,
    userWorkosId: input.actorId,
    path,
    content: createBrainMarkdownContent({
      id: draftBrainId,
      folderPath: BRAIN_CAPTURE_FOLDER,
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
    ? normalizeBrainPointerCapture({
        sourceRef: resolvedSourceRef,
        title,
        ...(fallbackText ? { fallbackText } : {}),
        chatSessionId: input.source.connectionId,
        userMessageId: input.source.itemId,
        draftBrainId,
        draftFolder: BRAIN_CAPTURE_FOLDER,
        capturedAt,
      })
    : normalizeChatCapture({
        text,
        title,
        ...(input.intent?.trim() ? { intent: input.intent.trim() } : {}),
        chatSessionId: input.source.connectionId,
        userMessageId: input.source.itemId,
        draftBrainId,
        draftFolder: BRAIN_CAPTURE_FOLDER,
        capturedAt,
        sourceRef: resolvedSourceRef,
        ...(idempotencyKey ? { externalId: idempotencyKey } : {}),
      });
  const result = await upsertBrainSourceItemAndEnqueue({
    userWorkosId: input.actorId,
    sourceConnectionId: isPointerCapture ? integrationId! : input.source.connectionId,
    ...(isPointerCapture ? { integrationId: integrationId! } : {}),
    item,
    rawPayload: item.content,
    kind: isPointerCapture ? BRAIN_POINTER_HYDRATE_JOB_KIND : BRAIN_AGENT_INGEST_JOB_KIND,
    brainRef: input.brainRef,
  });
  captureProductIngestionQuotaAnalytics(result.quotaUpdates);

  if (result.enqueued && dependencies.wakeIngest) {
    dependencies.wakeIngest().catch((error) => {
      console.warn("opencompany Brain capture failed to wake the ingest worker.", {
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
  const provider = parseBrainSourceRef(sourceRef)?.provider;
  return provider === "gmail" || provider === "linear" ? provider : null;
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
