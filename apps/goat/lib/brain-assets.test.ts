import { describe, expect, it, vi } from "vitest";
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
vi.mock("@/lib/brain", () => ({
  documentViewFromFileRow: vi.fn(),
  nextAvailableGoatBrainId: vi.fn(),
}));

describe("Goat Brain asset uploads", () => {
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
