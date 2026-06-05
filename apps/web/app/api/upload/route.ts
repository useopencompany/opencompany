import { ALLOWED_ATTACHMENT_MIME_TYPES, ATTACHMENT_MAX_BYTES } from "@opencompany/agent-runtime";
import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";
import { currentWorkspace } from "@/lib/auth";

// Mints short-lived client-upload tokens so the browser uploads directly to the private
// Blob store (bypasses the 4.5 MB serverless body limit). Auth + content-type + size are
// enforced here; the DB rows are written at message-submit time (onUploadCompleted does
// NOT fire on localhost, so we do not rely on it).
export async function POST(request: Request): Promise<Response> {
  const context = await currentWorkspace({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(`workspace/${context.workspace.id}/`)) {
          throw new Error("Pathname outside workspace scope.");
        }
        return {
          addRandomSuffix: true,
          allowedContentTypes: [...ALLOWED_ATTACHMENT_MIME_TYPES],
          maximumSizeInBytes: ATTACHMENT_MAX_BYTES,
        };
      },
      onUploadCompleted: async () => {
        // Intentionally empty — persistence happens at message submit. Does not run locally.
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
