import { ATTACHMENT_MAX_BYTES, ATTACHMENT_UPLOAD_CONTENT_TYPES } from "@opencompany/agent-runtime";
import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";
import { goatAttachmentBlobPrefix } from "@/lib/attachments";
import { currentGoatUser } from "@/lib/auth";

export async function POST(request: Request): Promise<Response> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const body = (await request.json()) as HandleUploadBody;
  const prefix = goatAttachmentBlobPrefix(context.user.workosUserId);

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(prefix)) {
          throw new Error("Pathname outside user scope.");
        }
        return {
          addRandomSuffix: true,
          allowedContentTypes: [...ATTACHMENT_UPLOAD_CONTENT_TYPES],
          maximumSizeInBytes: ATTACHMENT_MAX_BYTES,
        };
      },
      onUploadCompleted: async () => undefined,
    });
    return Response.json(jsonResponse);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 400 },
    );
  }
}
