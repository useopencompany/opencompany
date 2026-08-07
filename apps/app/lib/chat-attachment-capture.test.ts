import { put } from "@vercel/blob";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrainAssetForUser } from "@/lib/brain-assets";
import { downloadChatAttachment } from "@/lib/chat-attachments";
import { saveChatAttachmentsToBrain } from "./chat-attachment-capture";

vi.mock("@vercel/blob", () => ({ put: vi.fn() }));
vi.mock("@/lib/brain-assets", () => ({
  createBrainAssetForUser: vi.fn(),
  brainAssetUploadPrefix: vi.fn(() => "goat-brain/brain_1/assets/"),
}));
vi.mock("@/lib/brain-capture", () => ({ BRAIN_CAPTURE_FOLDER: "inbox" }));
vi.mock("@/lib/chat-attachments", () => ({ downloadChatAttachment: vi.fn() }));
vi.mock("@/lib/task-runner", () => ({
  triggerBrainIngestWake: vi.fn().mockResolvedValue(undefined),
}));

describe("saveChatAttachmentsToBrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(downloadChatAttachment).mockResolvedValue(Buffer.from("file"));
    vi.mocked(put).mockResolvedValue({ url: "https://blob.example/file.pdf" } as never);
  });

  it("returns an explicit plan-paused result for a preserved upload", async () => {
    vi.mocked(createBrainAssetForUser).mockResolvedValue({
      ok: true,
      path: "inbox/file.pdf",
      quotaPaused: true,
      document: {
        id: "document_1",
        title: "file.pdf",
      },
    } as never);

    const result = await saveChatAttachmentsToBrain({
      brainRef: "brain_1",
      userWorkosId: "user_1",
      attachmentIds: ["attachment_1"],
      sessionMessages: [
        {
          role: "user",
          attachments: [
            {
              id: "attachment_1",
              kind: "pdf",
              mediaType: "application/pdf",
              filename: "file.pdf",
              sizeBytes: 4,
              blobPathname: "goat-chat/file.pdf",
              blobUrl: "https://blob.example/source.pdf",
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      status: "paused_by_plan",
      message: expect.stringMatching(/Settings → Usage or Billing/),
    });
  });
});
