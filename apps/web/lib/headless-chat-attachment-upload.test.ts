import { describe, expect, it, vi } from "vitest";
import { uploadHeadlessChatAttachment } from "./headless-chat-attachment-upload";

describe("uploadHeadlessChatAttachment", () => {
  it("uploads bytes through the typed canonical operation and returns only the opaque id", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/v1/attachments");
      expect(request.method).toBe("POST");
      const form = await request.formData();
      const uploaded = form.get("file");
      expect(uploaded).toBeInstanceOf(File);
      expect((uploaded as File).name).toBe("brief.txt");
      return Response.json(
        {
          data: {
            attachment: {
              id: "attachment_1",
              filename: "brief.txt",
              mediaType: "text/plain",
              sizeBytes: 5,
              kind: "document",
            },
            expiresAt: "2026-08-11T20:00:00.000Z",
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        },
        { status: 201 },
      );
    });

    await expect(
      uploadHeadlessChatAttachment(
        { file: new File(["hello"], "brief.txt", { type: "text/plain" }) },
        { baseUrl: "https://app.example.test", fetch: fetchMock as typeof fetch },
      ),
    ).resolves.toEqual({ id: "attachment_1" });
  });
});
