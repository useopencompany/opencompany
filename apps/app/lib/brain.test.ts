import { parseBrainDocument } from "@opencompany/brain";
import {
  type createBrainMarkdownDocument as CreateBrainMarkdownDocument,
  deriveBrainFileProjection,
} from "@opencompany/db/brain-files";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrainDocumentForUser,
  createBrainSkillForUser,
  moveBrainDocumentForUser,
  renameBrainDocumentForUser,
  updateBrainSkillForUser,
} from "@/lib/brain";

const dbMocks = vi.hoisted(() => ({
  createBrainMarkdownDocument: vi.fn(),
  getBrainFile: vi.fn(),
  listBrainFiles: vi.fn(),
  moveBrainFile: vi.fn(),
  updateBrainFileContent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(),
}));

vi.mock("@opencompany/db/brain-files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/db/brain-files")>();
  return {
    ...actual,
    createBrainMarkdownDocument: dbMocks.createBrainMarkdownDocument,
    getBrainFile: dbMocks.getBrainFile,
    listBrainFiles: dbMocks.listBrainFiles,
    moveBrainFile: dbMocks.moveBrainFile,
    updateBrainFileContent: dbMocks.updateBrainFileContent,
  };
});

describe("manual brain documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.listBrainFiles.mockResolvedValue([]);
    dbMocks.createBrainMarkdownDocument.mockImplementation(
      async (input: Parameters<typeof CreateBrainMarkdownDocument>[0]) => {
        const projection = deriveBrainFileProjection({
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
    const result = await createBrainDocumentForUser({
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
    const input = dbMocks.createBrainMarkdownDocument.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      path: "projects/quarterly-roadmap.md",
    });
    expect(parseBrainDocument(input.content)).toMatchObject({
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

  it("creates a stable skill id with provided description frontmatter", async () => {
    const result = await createBrainSkillForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "skills/engineering",
      name: "Coding work",
      description: "How coding work should happen.",
    });

    expect(result).toMatchObject({
      ok: true,
      path: "skills/engineering/coding-work.md",
      document: {
        brainId: "coding-work",
        title: "Coding work",
        description: "How coding work should happen.",
      },
    });
    const input = dbMocks.createBrainMarkdownDocument.mock.calls[0]?.[0];
    expect(parseBrainDocument(input.content).frontmatter).toMatchObject({
      id: "coding-work",
      folder: "skills/engineering",
      title: "Coding work",
      description: "How coding work should happen.",
    });
  });

  it("creates a skill with only a name", async () => {
    const result = await createBrainSkillForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "skills",
      name: "Coding work",
    });

    expect(result).toMatchObject({
      ok: true,
      path: "skills/coding-work.md",
      document: {
        brainId: "coding-work",
        title: "Coding work",
      },
    });
    const input = dbMocks.createBrainMarkdownDocument.mock.calls[0]?.[0];
    expect(parseBrainDocument(input.content).frontmatter).not.toHaveProperty("description");
  });

  it("removes an optional description when updating a skill", async () => {
    await createBrainSkillForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "skills",
      name: "Coding work",
      description: "How coding work should happen.",
    });
    const existing = await dbMocks.createBrainMarkdownDocument.mock.results[0]?.value;
    dbMocks.getBrainFile.mockResolvedValue(existing);
    dbMocks.updateBrainFileContent.mockImplementation(async (input) => ({
      ...existing,
      ...deriveBrainFileProjection({ path: "skills/coding-work.md", content: input.content }),
      updatedAt: new Date("2026-07-13T12:05:00.000Z"),
    }));

    await expect(
      updateBrainSkillForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        documentId: existing.id,
        name: "Coding work",
        description: "",
        instructions: "Inspect, implement, and verify.",
      }),
    ).resolves.toMatchObject({ ok: true, document: { title: "Coding work" } });
    const input = dbMocks.updateBrainFileContent.mock.calls[0]?.[0];
    expect(parseBrainDocument(input.content).frontmatter).not.toHaveProperty("description");
  });

  it("rejects invalid descriptions and skill creation outside skills", async () => {
    await expect(
      createBrainSkillForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        folderPath: "projects",
        name: "Coding work",
        description: "How coding work should happen.",
      }),
    ).resolves.toEqual({ ok: false, message: 'Skills must live in the "skills" folder.' });
    await expect(
      createBrainSkillForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        folderPath: "skills",
        name: "Coding work",
        description: "Use <unsafe> markup.",
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'Skill descriptions cannot contain "<" or ">".',
    });
    expect(dbMocks.createBrainMarkdownDocument).not.toHaveBeenCalled();
  });

  it("keeps allocated skill ids within the native 64-character limit", async () => {
    const fullId = `s${"x".repeat(63)}`;
    dbMocks.listBrainFiles.mockResolvedValueOnce([{ brainId: fullId }]);

    const result = await createBrainSkillForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "skills",
      name: `s${"x".repeat(100)}`,
      description: "How coding work should happen.",
    });

    expect(result).toMatchObject({ ok: true });
    const input = dbMocks.createBrainMarkdownDocument.mock.calls[0]?.[0];
    const id = parseBrainDocument(input.content).frontmatter.id;
    expect(id).toHaveLength(64);
    expect(id?.endsWith("-2")).toBe(true);
  });

  it("preserves a skill description across rename and move rewrites", async () => {
    await createBrainSkillForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "skills",
      name: "Coding work",
      description: "How coding work should happen.",
    });
    const existing = await dbMocks.createBrainMarkdownDocument.mock.results[0]?.value;
    dbMocks.getBrainFile.mockResolvedValue(existing);
    dbMocks.updateBrainFileContent.mockImplementation(async (input) => ({
      ...existing,
      ...deriveBrainFileProjection({ path: "skills/coding-work.md", content: input.content }),
      updatedAt: new Date("2026-07-13T12:05:00.000Z"),
    }));
    dbMocks.moveBrainFile.mockImplementation(async (input) => ({
      ...existing,
      ...deriveBrainFileProjection({ path: input.path, content: input.content }),
      updatedAt: new Date("2026-07-13T12:10:00.000Z"),
    }));

    await expect(
      renameBrainDocumentForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        documentId: existing.id,
        title: "Engineering work",
      }),
    ).resolves.toMatchObject({
      ok: true,
      document: { description: "How coding work should happen." },
    });
    const renamedContent = dbMocks.updateBrainFileContent.mock.calls[0]?.[0].content;
    expect(parseBrainDocument(renamedContent).frontmatter.description).toBe(
      "How coding work should happen.",
    );

    await expect(
      moveBrainDocumentForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        documentId: existing.id,
        folderPath: "skills/engineering",
      }),
    ).resolves.toMatchObject({
      ok: true,
      document: { description: "How coding work should happen." },
    });
    const movedContent = dbMocks.moveBrainFile.mock.calls[0]?.[0].content;
    expect(parseBrainDocument(movedContent).frontmatter.description).toBe(
      "How coding work should happen.",
    );
  });

  it("allocates a non-conflicting Markdown id", async () => {
    dbMocks.listBrainFiles.mockResolvedValueOnce([{ brainId: "roadmap" }]);

    const result = await createBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });

    expect(result).toMatchObject({ ok: true, path: "projects/roadmap-2.md" });
    expect(dbMocks.createBrainMarkdownDocument).toHaveBeenCalledWith(
      expect.objectContaining({ path: "projects/roadmap-2.md" }),
    );
  });

  it("retries the next id when a concurrent create claims the first one", async () => {
    dbMocks.createBrainMarkdownDocument.mockResolvedValueOnce(null);

    const result = await createBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });

    expect(result).toMatchObject({ ok: true, path: "projects/roadmap-2.md" });
    expect(dbMocks.createBrainMarkdownDocument.mock.calls.map(([input]) => input.path)).toEqual([
      "projects/roadmap.md",
      "projects/roadmap-2.md",
    ]);
  });

  it("rejects file names that try to choose another folder", async () => {
    const result = await createBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "private/roadmap.md",
    });

    expect(result).toEqual({ ok: false, message: "File names cannot include a folder path." });
    expect(dbMocks.createBrainMarkdownDocument).not.toHaveBeenCalled();
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
    const result = await createBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      ...invalid,
    });

    expect(result).toEqual({ ok: false, message });
    expect(dbMocks.createBrainMarkdownDocument).not.toHaveBeenCalled();
  });

  it("returns a failed mutation when persistence fails", async () => {
    dbMocks.createBrainMarkdownDocument.mockRejectedValueOnce(new Error("Database unavailable"));

    const result = await createBrainDocumentForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });

    expect(result).toEqual({ ok: false, message: "Database unavailable" });
  });
});
