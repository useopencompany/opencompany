import { beforeEach, describe, expect, it, vi } from "vitest";
import { goatChatArtifactResponse } from "./chat-artifact-response";

const blobMocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: blobMocks.get }));

function blobResult(bytes = new TextEncoder().encode("# Plan")) {
  return {
    statusCode: 200,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

describe("goatChatArtifactResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blobMocks.get.mockResolvedValue(blobResult());
  });

  it("serves safe previews through a private, non-cacheable response", async () => {
    const response = await goatChatArtifactResponse(
      {
        blobPathname: "private/artifact/version_1",
        filename: "plan.md",
        mediaType: "text/markdown",
        sizeBytes: 6,
      },
      { download: false },
    );

    expect(blobMocks.get).toHaveBeenCalledWith("private/artifact/version_1", {
      access: "private",
      useCache: false,
    });
    expect(response.headers.get("Content-Disposition")).toBe(
      `inline; filename="plan.md"; filename*=UTF-8''plan.md`,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Length")).toBe("6");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
  });

  it("forces Office files and explicit downloads to attachment disposition", async () => {
    const response = await goatChatArtifactResponse(
      {
        blobPathname: "private/artifact/version_2",
        filename: 'fórécast"\r\n.xlsx',
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 6,
      },
      { download: false },
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="f_r_cast___.xlsx"; filename*=UTF-8''f%C3%B3r%C3%A9cast%22__.xlsx`,
    );
    expect(response.headers.has("Content-Security-Policy")).toBe(false);
  });

  it("returns 404 when the private blob no longer exists", async () => {
    blobMocks.get.mockResolvedValueOnce(null);
    await expect(
      goatChatArtifactResponse(
        {
          blobPathname: "missing",
          filename: "missing.pdf",
          mediaType: "application/pdf",
          sizeBytes: 6,
        },
        { download: false },
      ),
    ).resolves.toMatchObject({ status: 404 });
  });
});
