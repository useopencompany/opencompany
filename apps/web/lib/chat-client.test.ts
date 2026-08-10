import { afterEach, describe, expect, it, vi } from "vitest";
import { markGoatChatSeen } from "@/lib/chat-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("markGoatChatSeen", () => {
  it("posts the seen marker to a deployment-stable API route", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, error: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(markGoatChatSeen("goat_chat_1/2")).resolves.toEqual({
      ok: true,
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/chat/goat_chat_1%2F2/seen", {
      method: "POST",
    });
  });

  it("returns a useful fallback when the route response is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );

    await expect(markGoatChatSeen("goat_chat_1")).resolves.toEqual({
      ok: false,
      error: "Could not mark that chat as seen.",
    });
  });
});
