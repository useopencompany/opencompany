import { File } from "expo-file-system";
import { until } from "until-async";
import type { ChatModelId, ComposerAttachment } from "../chat-composer-context";
import { getChatDatabase, values, waitForChatWrites, withChatTransaction } from "./database";
import { attachmentDirectory, deleteFiles } from "./files";
import type { AttachmentRow, ChatPartition, DraftRow, StoredDraft } from "./types";

export const attachmentFromRow = (row: AttachmentRow): ComposerAttachment => ({
  id: row.local_id,
  kind: row.kind,
  uri: row.uri,
  name: row.filename,
  mimeType: row.media_type,
  size: row.size_bytes,
  ...(row.width === null ? {} : { width: row.width }),
  ...(row.height === null ? {} : { height: row.height }),
});

export const getStoredDraft = async (
  partition: ChatPartition,
  conversationId: string,
): Promise<StoredDraft> => {
  await waitForChatWrites();
  const database = await getChatDatabase();
  const row = await database.getFirstAsync<DraftRow>(
    `SELECT conversation_id, text, model_id FROM drafts
      WHERE user_id = ? AND workspace_id = ? AND conversation_id = ?`,
    ...values(partition),
    conversationId,
  );
  const attachments = await database.getAllAsync<AttachmentRow>(
    `SELECT local_id, conversation_id, uri, kind, filename, media_type, size_bytes, width,
            height, upload_generation, server_attachment_id, expires_at
       FROM attachments
      WHERE user_id = ? AND workspace_id = ? AND owner_kind = 'draft' AND owner_id = ?
      ORDER BY rowid ASC`,
    ...values(partition),
    conversationId,
  );
  return {
    conversationId,
    text: row?.text ?? "",
    modelId: row?.model_id ?? "moonshotai/kimi-k3",
    attachments: attachments.map(attachmentFromRow),
  };
};

export const saveStoredDraft = async (
  partition: ChatPartition,
  conversationId: string,
  text: string,
  modelId: ChatModelId,
): Promise<void> => {
  return withChatTransaction(partition, async (database) => {
    await database.runAsync(
      `INSERT INTO drafts (user_id, workspace_id, conversation_id, text, model_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, workspace_id, conversation_id) DO UPDATE SET
       text = excluded.text, model_id = excluded.model_id, updated_at = excluded.updated_at`,
      ...values(partition),
      conversationId,
      text,
      modelId,
      Date.now(),
    );
  });
};

export const persistDraftAttachment = async (
  partition: ChatPartition,
  conversationId: string,
  input: Omit<ComposerAttachment, "id" | "uri"> & { sourceUri: string },
): Promise<ComposerAttachment> => {
  const id = globalThis.crypto.randomUUID();
  const directory = attachmentDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const candidateExtension = input.name.includes(".")
    ? (input.name.split(".").at(-1)?.toLowerCase() ?? "")
    : "";
  const extension = /^[a-z0-9]{1,10}$/u.test(candidateExtension) ? `.${candidateExtension}` : "";
  const destination = new File(directory, `${id}${extension}`);
  await new File(input.sourceUri).copy(destination);
  const attachment: ComposerAttachment = {
    id,
    kind: input.kind,
    uri: destination.uri,
    name: input.name,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.size ? { size: input.size } : {}),
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
  };
  const [persistError] = await until(() =>
    withChatTransaction(partition, async (database) => {
      await database.runAsync(
        `INSERT INTO attachments (
          user_id, workspace_id, local_id, conversation_id, owner_kind, owner_id, uri, kind,
          filename, media_type, size_bytes, width, height, upload_generation
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ...values(partition),
        id,
        conversationId,
        conversationId,
        destination.uri,
        input.kind,
        input.name,
        input.mimeType ?? "",
        input.size ?? 0,
        input.width ?? null,
        input.height ?? null,
      );
    }),
  );
  if (persistError) {
    if (destination.exists) destination.delete();
    throw persistError;
  }
  return attachment;
};

export const removeStoredAttachment = async (
  partition: ChatPartition,
  attachmentId: string,
): Promise<void> => {
  const uri = await withChatTransaction(partition, async (database) => {
    const row = await database.getFirstAsync<{ uri: string }>(
      "SELECT uri FROM attachments WHERE user_id = ? AND workspace_id = ? AND local_id = ? AND owner_kind = 'draft'",
      ...values(partition),
      attachmentId,
    );
    if (!row) return null;
    await database.runAsync(
      "DELETE FROM attachments WHERE user_id = ? AND workspace_id = ? AND local_id = ?",
      ...values(partition),
      attachmentId,
    );
    return row.uri;
  });
  if (uri) deleteFiles([uri]);
};
