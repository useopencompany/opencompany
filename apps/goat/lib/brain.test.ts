import {
  type createGoatBrainMarkdownDocument as CreateGoatBrainMarkdownDocument,
  deriveGoatBrainFileProjection,
} from "@opencompany/db/goat-brain-files";
import { parseGoatBrainDocument } from "@opencompany/goat-brain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatBrainDocumentForUser } from "@/lib/brain";

const dbMocks = vi.hoisted(() => ({
  createGoatBrainMarkdownDocument: vi.fn(),
  listGoatBrainFiles: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@opencompany/db/goat-brain-files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/db/goat-brain-files")>();
  return {
    ...actual,
    createGoatBrainMarkdownDocument: dbMocks.createGoatBrainMarkdownDocument,
    listGoatBrainFiles: dbMocks.listGoatBrainFiles,
  };
});

describe("manual Goat brain documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.listGoatBrainFiles.mockResolvedValue([]);
    dbMocks.createGoatBrainMarkdownDocument.mockImplementation(
      async (input: Parameters<typeof CreateGoatBrainMarkdownDocument>[0]) => {
        const projection = deriveGoatBrainFileProjection({
          path: input.path,
          content: input.content,
        });
        const now = new Date("2026-07-13T12:00:00.000Z");
        return {
          id: "goat_brain_doc_new",
          userWorkosId: input.userWorkosId,
          createdByWorkosId: input.userWorkosId,
          brainRef: input.brainRef,
          ...projection,
          originalFileName: null,
          assetStorageKey: null,
          assetSizeBytes: null,
          assetContentHash: null,
          assetExtractedText: null,
          parseError: null,
          createdAt: now,
          updatedAt: now,
        };
      },
    );
  });

  it("creates an empty draft note from a Markdown file name", async () => {
    const result = await createGoatBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "Quarterly Roadmap.md",
    });

    expect(result).toMatchObject({
      ok: true,
      path: "projects/quarterly-roadmap.md",
      document: {
        brainId: "quarterly-roadmap",
        folderPath: "projects",
        title: "Quarterly Roadmap",
        type: "note",
        status: "draft",
        body: "_No compiled truth yet._",
      },
    });
    const input = dbMocks.createGoatBrainMarkdownDocument.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      path: "projects/quarterly-roadmap.md",
    });
    expect(parseGoatBrainDocument(input.content)).toMatchObject({
      frontmatter: {
        id: "quarterly-roadmap",
        folder: "projects",
        kind: "page",
        type: "note",
        status: "draft",
        title: "Quarterly Roadmap",
      },
      compiledTruth: "_No compiled truth yet._",
    });
  });

  it("allocates a non-conflicting Markdown id", async () => {
    dbMocks.listGoatBrainFiles.mockResolvedValueOnce([{ brainId: "roadmap" }]);

    const result = await createGoatBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });

    expect(result).toMatchObject({ ok: true, path: "projects/roadmap-2.md" });
    expect(dbMocks.createGoatBrainMarkdownDocument).toHaveBeenCalledWith(
      expect.objectContaining({ path: "projects/roadmap-2.md" }),
    );
  });

  it("retries the next id when a concurrent create claims the first one", async () => {
    dbMocks.createGoatBrainMarkdownDocument.mockResolvedValueOnce(null);

    const result = await createGoatBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });

    expect(result).toMatchObject({ ok: true, path: "projects/roadmap-2.md" });
    expect(dbMocks.createGoatBrainMarkdownDocument.mock.calls.map(([input]) => input.path)).toEqual(
      ["projects/roadmap.md", "projects/roadmap-2.md"],
    );
  });

  it("rejects file names that try to choose another folder", async () => {
    const result = await createGoatBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "private/roadmap.md",
    });

    expect(result).toEqual({ ok: false, message: "File names cannot include a folder path." });
    expect(dbMocks.createGoatBrainMarkdownDocument).not.toHaveBeenCalled();
  });

  it.each([
    [
      "blank file name",
      { folderPath: "projects", fileName: "   " },
      "Give the Markdown file a name.",
    ],
    [
      "long file name",
      { folderPath: "projects", fileName: `${"a".repeat(161)}.md` },
      "File names must be 160 characters or fewer.",
    ],
    [
      "non-slug file name",
      { folderPath: "projects", fileName: "---.md" },
      "File names must contain at least one letter or number.",
    ],
    [
      "invalid folder",
      { folderPath: "../projects", fileName: "Roadmap.md" },
      "Folder paths must be lowercase slugs separated by /.",
    ],
  ])("rejects a %s", async (_label, invalid, message) => {
    const result = await createGoatBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      ...invalid,
    });

    expect(result).toEqual({ ok: false, message });
    expect(dbMocks.createGoatBrainMarkdownDocument).not.toHaveBeenCalled();
  });

  it("returns a failed mutation when persistence fails", async () => {
    dbMocks.createGoatBrainMarkdownDocument.mockRejectedValueOnce(
      new Error("Database unavailable"),
    );

    const result = await createGoatBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });

    expect(result).toEqual({ ok: false, message: "Database unavailable" });
  });
});
