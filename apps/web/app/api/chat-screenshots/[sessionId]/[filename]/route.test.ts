import { beforeEach, describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/headless-api-proxy", () => ({ proxyHeadlessApiRequest: proxy }));

import { GET } from "./route";

describe("legacy Chat screenshot URL relay", () => {
  beforeEach(() => {
    proxy.mockReset();
    proxy.mockResolvedValue(new Response("image", { status: 200 }));
  });

  it("streams the existing public URL through the canonical API resource", async () => {
    const request = new Request("https://app.example.test/api/chat-screenshots/session_1/shot.png");
    const response = await GET(request, {
      params: Promise.resolve({ sessionId: "session_1", filename: "shot.png" }),
    });

    expect(response.status).toBe(200);
    expect(proxy).toHaveBeenCalledWith(request, ["chat-screenshots", "session_1", "shot.png"]);
  });
});
