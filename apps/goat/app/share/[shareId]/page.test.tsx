import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateMetadata } from "./page";

const loadPublicGoatChatMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/chat/SharedChatView", () => ({
  SharedChatView: vi.fn(() => null),
}));

vi.mock("@/lib/app-url", () => ({
  getGoatAppUrl: vi.fn(() => "https://goat.example.com"),
}));

vi.mock("@/lib/chat-sharing", () => ({
  loadPublicGoatChat: loadPublicGoatChatMock,
}));

const SHARE_ID = "goat_chat_share_123e4567-e89b-42d3-a456-426614174000";

describe("shared chat metadata", () => {
  beforeEach(() => {
    loadPublicGoatChatMock.mockResolvedValue({
      shareId: SHARE_ID,
      title: "Architecture review",
      kind: "chat",
      messages: [],
    });
  });

  it("uses the session title across document, Open Graph, and Twitter metadata", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ shareId: SHARE_ID }),
    });

    expect(metadata).toMatchObject({
      title: "Architecture review",
      description: "Architecture review — a read-only chat shared from opencompany.",
      robots: {
        index: false,
        follow: false,
        noarchive: true,
      },
      referrer: "no-referrer",
      openGraph: {
        type: "website",
        locale: "en_US",
        siteName: "opencompany",
        title: "Architecture review",
        description: "Architecture review — a read-only chat shared from opencompany.",
        url: new URL(`https://goat.example.com/share/${SHARE_ID}`),
        images: [
          {
            url: new URL(`https://goat.example.com/share/${SHARE_ID}/opengraph-image`),
            width: 1200,
            height: 630,
            type: "image/png",
            alt: "Architecture review — shared chat on opencompany",
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title: "Architecture review",
        description: "Architecture review — a read-only chat shared from opencompany.",
        images: [
          {
            url: new URL(`https://goat.example.com/share/${SHARE_ID}/opengraph-image`),
            width: 1200,
            height: 630,
            type: "image/png",
            alt: "Architecture review — shared chat on opencompany",
          },
        ],
      },
    });
  });

  it("describes shared task runs distinctly from chats", async () => {
    loadPublicGoatChatMock.mockResolvedValueOnce({
      shareId: SHARE_ID,
      title: "Ship feature",
      kind: "task",
      messages: [],
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ shareId: SHARE_ID }),
    });

    expect(metadata).toMatchObject({
      title: "Ship feature",
      description: "Ship feature — a read-only task run shared from opencompany.",
      openGraph: {
        description: "Ship feature — a read-only task run shared from opencompany.",
        images: [
          expect.objectContaining({
            alt: "Ship feature — shared task run on opencompany",
          }),
        ],
      },
      twitter: {
        description: "Ship feature — a read-only task run shared from opencompany.",
        images: [
          expect.objectContaining({
            alt: "Ship feature — shared task run on opencompany",
          }),
        ],
      },
    });
  });

  it("returns not found when a share does not exist", async () => {
    loadPublicGoatChatMock.mockResolvedValueOnce(null);

    await expect(
      generateMetadata({
        params: Promise.resolve({
          shareId: "goat_chat_share_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      }),
    ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});
