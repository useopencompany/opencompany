import {
  createGoatBrainAssetDocument,
  goatBrainFilePathFor,
} from "@opencompany/db/goat-brain-files";
import { upsertGoatBrainSourceItemAndEnqueue } from "@opencompany/db/goat-brain-ingest";
import {
  documentViewFromFileRow,
  nextAvailableGoatBrainId,
} from "@opencompany/goat-agent/brain-files";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatBrainAssetForUser } from "./brain-assets";

vi.mock("@opencompany/analytics/goat", () => ({
  captureGoatIngestionQuotaAnalytics: vi.fn(),
}));
vi.mock("@opencompany/db/goat-brain-files", () => ({
  createGoatBrainAssetDocument: vi.fn(),
  goatBrainFilePathFor: vi.fn(),
  replaceGoatBrainAssetFile: vi.fn(),
}));
vi.mock("@opencompany/db/goat-brain-ingest", () => ({
  GOAT_BRAIN_AGENT_INGEST_JOB_KIND: "goat-brain-agent-ingest",
  upsertGoatBrainSourceItemAndEnqueue: vi.fn(),
}));
vi.mock("@opencompany/goat-agent/brain-files", () => ({
  documentViewFromFileRow: vi.fn(),
  nextAvailableGoatBrainId: vi.fn(),
}));

describe("Goat Brain asset uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores an SRT asset with a canonical MIME type when the browser reports plain text", async () => {
    vi.mocked(nextAvailableGoatBrainId).mockResolvedValue("captions");
    vi.mocked(createGoatBrainAssetDocument).mockResolvedValue({
      id: "document_1",
      brainId: "captions",
      folderPath: "inbox",
    } as never);
    vi.mocked(upsertGoatBrainSourceItemAndEnqueue).mockResolvedValue({
      paused: false,
      quotaUpdates: [],
    } as never);
    vi.mocked(documentViewFromFileRow).mockReturnValue({ id: "document_1" } as never);
    vi.mocked(goatBrainFilePathFor).mockReturnValue("inbox/captions.md");

    const result = await createGoatBrainAssetForUser({
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
    expect(createGoatBrainAssetDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "srt",
        mimeType: "application/x-subrip",
        originalFileName: "captions.srt",
        assetContentHash: "a".repeat(64),
      }),
      {},
    );
  });

  it("requires the SRT extension for subtitle MIME types", async () => {
    await expect(
      createGoatBrainAssetForUser({
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
    vi.mocked(nextAvailableGoatBrainId).mockResolvedValue("customers");
    vi.mocked(createGoatBrainAssetDocument).mockResolvedValue({
      id: "document_1",
      brainId: "customers",
      folderPath: "inbox",
    } as never);
    vi.mocked(upsertGoatBrainSourceItemAndEnqueue).mockResolvedValue({
      paused: false,
      quotaUpdates: [],
    } as never);
    vi.mocked(documentViewFromFileRow).mockReturnValue({ id: "document_1" } as never);
    vi.mocked(goatBrainFilePathFor).mockReturnValue("inbox/customers.md");

    const result = await createGoatBrainAssetForUser({
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
    expect(createGoatBrainAssetDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "csv",
        mimeType: "text/csv",
        originalFileName: "customers.csv",
        assetContentHash: "a".repeat(64),
      }),
      {},
    );
  });

  it("rejects uploads inside the skills zone", async () => {
    await expect(
      createGoatBrainAssetForUser({
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
