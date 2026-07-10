import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";
import { currentGoatUser } from "@/lib/auth";
import {
  GOAT_CHAT_ATTACHMENT_CONTENT_TYPES,
  GOAT_CHAT_ATTACHMENT_MAX_BYTES,
} from "@/lib/chat-attachment-formats";

export function goatChatAttachmentUploadPrefix(userWorkosId: string): string {
  return `goat-chat/${userWorkosId}/`;
}

// Mints short-lived client-upload tokens so the browser uploads chat
// attachments directly to the private Blob store. Mirrors
// /api/brain-assets/upload: auth + pathname scope + content-type + size are
// enforced here; the attachment metadata is persisted with the chat message
// when the user sends it (onUploadCompleted does not fire on localhost).
export async function POST(request: Request): Promise<Response> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const prefix = goatChatAttachmentUploadPrefix(context.user.workosUserId);
  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.replace(/^\/+/, "").startsWith(prefix)) {
          throw new Error("Pathname outside your chat attachment scope.");
        }
        return {
          addRandomSuffix: true,
          allowedContentTypes: [...GOAT_CHAT_ATTACHMENT_CONTENT_TYPES],
          maximumSizeInBytes: GOAT_CHAT_ATTACHMENT_MAX_BYTES,
        };
      },
      onUploadCompleted: async () => {
        // Intentionally empty — persistence happens when the message is sent.
      },
    });
    return Response.json(jsonResponse);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 400 },
    );
  }
}
