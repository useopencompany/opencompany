import { createHash } from "node:crypto";
import { put } from "@vercel/blob";
import { createGoatBrainAssetForUser, goatBrainAssetUploadPrefix } from "@/lib/brain-assets";
import { GOAT_BRAIN_CAPTURE_FOLDER } from "@/lib/brain-capture";
import { downloadGoatChatAttachment } from "@/lib/chat-attachments";
import type { GoatStoredChatMessage, SaveToBrainToolOutput } from "@/lib/chat-ui";
import { triggerGoatBrainIngestWake } from "@/lib/task-runner";

// save_to_brain with attachmentIds: files attached in the chat become brain
// asset documents. Copy-at-boundary — the chat blob stays under the user's
// goat-chat/ prefix; the brain gets its own copy under goat-brain/{brainRef}/
// assets/, so per-brain isolation (and the prefix check in
// createGoatBrainAssetForUser) holds without exceptions.
export async function saveChatAttachmentsToGoatBrain(input: {
  brainRef: string;
  userWorkosId: string;
  attachmentIds: string[];
  sessionMessages: readonly Pick<GoatStoredChatMessage, "role" | "attachments">[];
}): Promise<SaveToBrainToolOutput> {
  const attachmentsById = new Map(
    input.sessionMessages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.attachments ?? [])
      .map((attachment) => [attachment.id, attachment]),
  );

  const assets: Array<{ documentId: string; path: string; title: string }> = [];
  let quotaPaused = false;
  for (const attachmentId of input.attachmentIds) {
    const attachment = attachmentsById.get(attachmentId);
    if (!attachment) {
      return {
        ok: false,
        error: `Attachment ${attachmentId} was not found in this conversation.`,
      };
    }

    let bytes: Buffer;
    try {
      bytes = await downloadGoatChatAttachment(attachment.blobUrl);
    } catch {
      return { ok: false, error: `Attachment "${attachment.filename}" could not be loaded.` };
    }
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");

    const copy = await put(
      `${goatBrainAssetUploadPrefix(input.brainRef)}${attachment.filename}`,
      bytes,
      {
        access: "private",
        addRandomSuffix: true,
        contentType: attachment.mediaType,
      },
    );

    const created = await createGoatBrainAssetForUser({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      folderPath: GOAT_BRAIN_CAPTURE_FOLDER,
      blobUrl: copy.url,
      originalFileName: attachment.filename,
      mimeType: attachment.mediaType,
      sizeBytes: bytes.byteLength,
      contentSha256,
    });
    if (!created.ok) return { ok: false, error: created.message };
    if (!created.document || !created.path) {
      return { ok: false, error: `Attachment "${attachment.filename}" could not be filed.` };
    }
    quotaPaused ||= Boolean(created.quotaPaused);
    assets.push({
      documentId: created.document.id,
      path: created.path,
      title: created.document.title,
    });
  }

  triggerGoatBrainIngestWake().catch((error) => {
    console.warn("Goat chat attachment capture failed to wake the ingest worker.", {
      event: "goat.chat_attachment_capture_wake_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return {
    ok: true,
    status: quotaPaused ? "paused_by_plan" : "captured",
    ...(quotaPaused
      ? {
          message:
            "Saved to the brain. Ingestion is paused by the workspace plan; see Settings → Usage or Billing to review the limit or upgrade.",
        }
      : {}),
    assets,
  };
}
