import { beforeEach, describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/headless-api-proxy", () => ({ proxyHeadlessApiRequest: proxy }));

import { GET } from "./route";

describe("public shared Chat attachment relay", () => {
  beforeEach(() => {
    proxy.mockReset();
    proxy.mockResolvedValue(new Response("attachment", { status: 200 }));
  });

  it("preserves the share URL while streaming from API ownership", async () => {
    const request = new Request(
      "https://app.example.test/share/share_1/attachments/message_1/attachment_1",
    );
    const response = await GET(request, {
      params: Promise.resolve({
        shareId: "share_1",
        messageId: "message_1",
        attachmentId: "attachment_1",
      }),
    });

    expect(response.status).toBe(200);
    expect(proxy).toHaveBeenCalledWith(
      request,
      ["public", "chat-shares", "share_1", "attachments", "message_1", "attachment_1"],
      { basePath: "" },
    );
  });
});
