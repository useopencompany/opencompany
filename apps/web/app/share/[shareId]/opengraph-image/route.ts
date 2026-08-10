import { createSharedChatOpenGraphImage } from "@/components/chat/SharedChatOpenGraphImage";
import { loadPublicGoatChatMetadata } from "@/lib/chat-sharing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  const chat = await loadPublicGoatChatMetadata(shareId);
  if (!chat) {
    return new Response(null, {
      status: 404,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  }

  return createSharedChatOpenGraphImage(chat.title);
}
