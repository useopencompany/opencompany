import { brainFilePathFor, createBrainAssetDocument } from "@opencompany/db/brain-files";
import { upsertBrainSourceItemAndEnqueue } from "@opencompany/db/brain-ingest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentViewFromFileRow, nextAvailableBrainId } from "@/lib/brain";
import { createBrainAssetForUser } from "./brain-assets";

vi.mock("@opencompany/analytics/app", () => ({
  captureIngestionQuotaAnalytics: vi.fn(),
}));
vi.mock("@opencompany/db/brain-files", () => ({
  createBrainAssetDocument: vi.fn(),
  brainFilePathFor: vi.fn(),
  replaceBrainAssetFile: vi.fn(),
}));
vi.mock("@opencompany/db/brain-ingest", () => ({
  BRAIN_AGENT_INGEST_JOB_KIND: "goat-brain-agent-ingest",
  upsertBrainSourceItemAndEnqueue: vi.fn(),
}));
vi.mock("@/lib/brain", () => ({
  documentViewFromFileRow: vi.fn(),
  nextAvailableBrainId: vi.fn(),
}));

describe("Goat Brain asset uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores an SRT asset with a canonical MIME type when the browser reports plain text", async () => {
    vi.mocked(nextAvailableBrainId).mockResolvedValue("captions");
    vi.mocked(createBrainAssetDocument).mockResolvedValue({
      id: "document_1",
      brainId: "captions",
      folderPath: "inbox",
    } as never);
    vi.mocked(upsertBrainSourceItemAndEnqueue).mockResolvedValue({
      paused: false,
      quotaUpdates: [],
    } as never);
    vi.mocked(documentViewFromFileRow).mockReturnValue({ id: "document_1" } as never);
    vi.mocked(brainFilePathFor).mockReturnValue("inbox/captions.md");

    const result = await createBrainAssetForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "inbox",
      blobUrl: "https://blob.test/goat-brain/goat_brain_1/assets/captions.srt",
      originalFileName: "captions.srt",
      mimeType: "text/plain",
      sizeBytes: 128,
      contentSha256: "a".repeat(64),
    });

    expect(result).toMatchObject({ ok: true, path: "inbox/captions.md" });
    expect(createBrainAssetDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "srt",
        mimeType: "application/x-subrip",
        originalFileName: "captions.srt",
      }),
    );
  });

  it("requires the SRT extension for subtitle MIME types", async () => {
    await expect(
      createBrainAssetForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        folderPath: "inbox",
        blobUrl: "https://blob.test/goat-brain/goat_brain_1/assets/captions.txt",
        originalFileName: "captions.txt",
        mimeType: "application/x-subrip",
        sizeBytes: 128,
        contentSha256: "a".repeat(64),
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Subtitle files must use the .srt extension.",
    });
  });

  it("stores a CSV asset with a canonical MIME type when the browser reports Excel", async () => {
    vi.mocked(nextAvailableBrainId).mockResolvedValue("customers");
    vi.mocked(createBrainAssetDocument).mockResolvedValue({
      id: "document_1",
      brainId: "customers",
      folderPath: "inbox",
    } as never);
    vi.mocked(upsertBrainSourceItemAndEnqueue).mockResolvedValue({
      paused: false,
      quotaUpdates: [],
    } as never);
    vi.mocked(documentViewFromFileRow).mockReturnValue({ id: "document_1" } as never);
    vi.mocked(brainFilePathFor).mockReturnValue("inbox/customers.md");

    const result = await createBrainAssetForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "inbox",
      blobUrl: "https://blob.test/goat-brain/goat_brain_1/assets/customers.csv",
      originalFileName: "customers.csv",
      mimeType: "application/vnd.ms-excel",
      sizeBytes: 128,
      contentSha256: "a".repeat(64),
    });

    expect(result).toMatchObject({ ok: true, path: "inbox/customers.md" });
    expect(createBrainAssetDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "csv",
        mimeType: "text/csv",
        originalFileName: "customers.csv",
      }),
    );
  });

  it("rejects uploads inside the skills zone", async () => {
    await expect(
      createBrainAssetForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        folderPath: "skills/engineering",
        blobUrl: "https://blob.test/goat-brain/goat_brain_1/assets/guide.pdf",
        originalFileName: "guide.pdf",
        mimeType: "application/pdf",
        sizeBytes: 128,
        contentSha256: "a".repeat(64),
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Skills are Markdown-only and cannot contain uploads.",
    });
  });
});
