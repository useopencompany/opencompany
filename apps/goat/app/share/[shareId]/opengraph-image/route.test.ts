import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const createSharedChatOpenGraphImageMock = vi.hoisted(() => vi.fn());
const loadPublicGoatChatMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/chat/SharedChatOpenGraphImage", () => ({
  createSharedChatOpenGraphImage: createSharedChatOpenGraphImageMock,
}));

vi.mock("@/lib/chat-sharing", () => ({
  loadPublicGoatChatMetadata: loadPublicGoatChatMetadataMock,
}));

const SHARE_ID = "goat_chat_share_123e4567-e89b-42d3-a456-426614174000";

describe("shared chat Open Graph image", () => {
  beforeEach(() => {
    loadPublicGoatChatMetadataMock.mockResolvedValue({
      shareId: SHARE_ID,
      title: "Architecture review",
      kind: "chat",
      engine: "opencompany",
    });
    createSharedChatOpenGraphImageMock.mockReturnValue(
      new Response("image", {
        headers: { "Content-Type": "image/png" },
      }),
    );
  });

  it("renders the image from only the public session metadata", async () => {
    const response = await GET(new Request(`https://goat.example.com/share/${SHARE_ID}`), {
      params: Promise.resolve({ shareId: SHARE_ID }),
    });

    expect(loadPublicGoatChatMetadataMock).toHaveBeenCalledWith(SHARE_ID);
    expect(createSharedChatOpenGraphImageMock).toHaveBeenCalledWith("Architecture review");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });

  it("returns a non-cacheable 404 after a share is revoked", async () => {
    loadPublicGoatChatMetadataMock.mockResolvedValueOnce(null);

    const response = await GET(new Request(`https://goat.example.com/share/${SHARE_ID}`), {
      params: Promise.resolve({ shareId: SHARE_ID }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
    expect(createSharedChatOpenGraphImageMock).not.toHaveBeenCalled();
  });
});
