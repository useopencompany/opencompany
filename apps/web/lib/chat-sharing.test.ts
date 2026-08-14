import { PROTOCOL_VERSION } from "@opencompany/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPublicChat, loadPublicChatMetadata } from "@/lib/chat-sharing";

const SHARE_ID = "goat_chat_share_01234567-89ab-4cde-8f01-23456789abcd";
const meta = { apiVersion: "v1" as const, protocolVersion: PROTOCOL_VERSION };

describe("public Chat share API adapter", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("loads and validates a public presentation transcript", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          shareId: SHARE_ID,
          title: "Shared Chat",
          kind: "chat",
          engine: "codex",
          messages: [{ id: "message_1", role: "assistant", parts: [{ type: "text", text: "Hi" }] }],
        },
        meta,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadPublicChat(`  ${SHARE_ID}  `)).resolves.toMatchObject({
      shareId: SHARE_ID,
      title: "Shared Chat",
      engine: "codex",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example.test/public/chat-shares/${SHARE_ID}`,
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("uses the metadata-only public resource for previews", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          shareId: SHARE_ID,
          title: "Shared Task",
          kind: "task",
          engine: "opencompany",
        },
        meta,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadPublicChatMetadata(SHARE_ID)).resolves.toMatchObject({
      title: "Shared Task",
      kind: "task",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.example.test/public/chat-shares/${SHARE_ID}/metadata`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns not found without calling the API for malformed capabilities", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadPublicChat("../conversation_1")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a revoked capability to not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(loadPublicChat(SHARE_ID)).resolves.toBeNull();
  });
});
