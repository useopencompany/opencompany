import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateMetadata } from "./page";

const loadPublicChatMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/chat/SharedChatView", () => ({
  SharedChatView: vi.fn(() => null),
}));

vi.mock("@opencompany/core/app-url", () => ({
  getAppUrl: vi.fn(() => "https://app.example.com"),
}));

vi.mock("@/lib/chat-sharing", () => ({
  loadPublicChat: loadPublicChatMock,
}));

const SHARE_ID = "goat_chat_share_123e4567-e89b-42d3-a456-426614174000";

describe("shared chat metadata", () => {
  beforeEach(() => {
    loadPublicChatMock.mockResolvedValue({
      shareId: SHARE_ID,
      title: "Architecture review",
      kind: "chat",
      engine: "opencompany",
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
        url: new URL(`https://app.example.com/share/${SHARE_ID}`),
        images: [
          {
            url: new URL(`https://app.example.com/share/${SHARE_ID}/opengraph-image`),
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
            url: new URL(`https://app.example.com/share/${SHARE_ID}/opengraph-image`),
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
    loadPublicChatMock.mockResolvedValueOnce({
      shareId: SHARE_ID,
      title: "Ship feature",
      kind: "task",
      engine: "codex",
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

  it.each([
    ["codex", "Codex chat"],
    ["claude_code", "Claude Code chat"],
  ] as const)("describes shared %s cloud chats distinctly", async (engine, subject) => {
    loadPublicChatMock.mockResolvedValueOnce({
      shareId: SHARE_ID,
      title: `${subject} session`,
      kind: "chat",
      engine,
      messages: [],
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ shareId: SHARE_ID }),
    });

    expect(metadata).toMatchObject({
      title: `${subject} session`,
      description: `${subject} session — a read-only ${subject} shared from opencompany.`,
      openGraph: {
        description: `${subject} session — a read-only ${subject} shared from opencompany.`,
        images: [
          expect.objectContaining({
            alt: `${subject} session — shared ${subject} on opencompany`,
          }),
        ],
      },
      twitter: {
        description: `${subject} session — a read-only ${subject} shared from opencompany.`,
        images: [
          expect.objectContaining({
            alt: `${subject} session — shared ${subject} on opencompany`,
          }),
        ],
      },
    });
  });

  it("returns not found when a share does not exist", async () => {
    loadPublicChatMock.mockResolvedValueOnce(null);

    await expect(
      generateMetadata({
        params: Promise.resolve({
          shareId: "goat_chat_share_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      }),
    ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});
