import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";
import { currentUser } from "@/lib/auth";
import {
  BRAIN_ASSET_CONTENT_TYPES,
  BRAIN_ASSET_MAX_BYTES,
  brainAssetUploadPrefix,
} from "@/lib/brain-assets";

// Temporary cached-client and rollback adapter. Current first-party clients send
// multipart bytes to the canonical API, but already-loaded clients still use
// this URL to mint a brain-scoped private Blob token before registration.
// Remove only after the #1203 compatibility observation window closes.
export async function POST(request: Request): Promise<Response> {
  const context = await currentUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const accessibleBrainRefs = new Set(context.brains.map((brain) => brain.id));
  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const brainRef = brainRefFromAssetPathname(pathname);
        if (!brainRef || !accessibleBrainRefs.has(brainRef)) {
          throw new Error("Pathname outside an accessible brain's asset scope.");
        }
        return {
          addRandomSuffix: true,
          allowedContentTypes: [...BRAIN_ASSET_CONTENT_TYPES],
          maximumSizeInBytes: BRAIN_ASSET_MAX_BYTES,
        };
      },
      onUploadCompleted: async () => {
        // Legacy persistence happens in the cached client's follow-up action.
        // This callback does not run locally and is not a durable command.
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

function brainRefFromAssetPathname(pathname: string): string | null {
  const match = /^goat-brain\/([^/]+)\/assets\/.+/.exec(pathname.replace(/^\/+/, ""));
  const brainRef = match?.[1];
  if (!brainRef) return null;
  return pathname.replace(/^\/+/, "").startsWith(brainAssetUploadPrefix(brainRef))
    ? brainRef
    : null;
}
