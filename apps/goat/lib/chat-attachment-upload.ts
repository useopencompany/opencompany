import { upload } from "@vercel/blob/client";

// Client-side half of the chat attachment upload: the browser uploads
// directly to the private Blob store (token minted by
// /api/chat-attachments/upload); the attachment metadata rides on the chat
// message when the user sends it. Mirrors lib/brain-asset-upload.ts — no
// client-side sha here because save_to_brain recomputes it server-side.
export async function uploadGoatChatAttachmentBlob(
  userWorkosId: string,
  file: File,
): Promise<{ blobUrl: string; blobPathname: string }> {
  const blob = await upload(`goat-chat/${userWorkosId}/${file.name}`, file, {
    access: "private",
    handleUploadUrl: "/api/chat-attachments/upload",
    contentType: file.type,
  });
  return { blobUrl: blob.url, blobPathname: blob.pathname };
}
