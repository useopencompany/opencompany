import {
  type createGoatBrainMarkdownDocument as CreateGoatBrainMarkdownDocument,
  deriveGoatBrainFileProjection,
} from "@opencompany/db/goat-brain-files";
import { parseGoatBrainDocument } from "@opencompany/goat-brain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoatBrainDocumentForUser,
  createGoatBrainSkillForUser,
  moveGoatBrainDocumentForUser,
  renameGoatBrainDocumentForUser,
  updateGoatBrainSkillForUser,
} from "@/lib/brain";

const dbMocks = vi.hoisted(() => ({
  createGoatBrainMarkdownDocument: vi.fn(),
  getGoatBrainFile: vi.fn(),
  listGoatBrainFiles: vi.fn(),
  moveGoatBrainFile: vi.fn(),
  updateGoatBrainFileContent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("@opencompany/db/goat-brain-files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/db/goat-brain-files")>();
  return {
    ...actual,
    createGoatBrainMarkdownDocument: dbMocks.createGoatBrainMarkdownDocument,
    getGoatBrainFile: dbMocks.getGoatBrainFile,
    listGoatBrainFiles: dbMocks.listGoatBrainFiles,
    moveGoatBrainFile: dbMocks.moveGoatBrainFile,
    updateGoatBrainFileContent: dbMocks.updateGoatBrainFileContent,
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

  it("creates a stable skill id with provided description frontmatter", async () => {
    const result = await createGoatBrainSkillForUser({
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
    const input = dbMocks.createGoatBrainMarkdownDocument.mock.calls[0]?.[0];
    expect(parseGoatBrainDocument(input.content).frontmatter).toMatchObject({
      id: "coding-work",
      folder: "skills/engineering",
      title: "Coding work",
      description: "How coding work should happen.",
    });
  });

  it("creates a skill with only a name", async () => {
    const result = await createGoatBrainSkillForUser({
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
    const input = dbMocks.createGoatBrainMarkdownDocument.mock.calls[0]?.[0];
    expect(parseGoatBrainDocument(input.content).frontmatter).not.toHaveProperty("description");
  });

  it("removes an optional description when updating a skill", async () => {
    await createGoatBrainSkillForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "skills",
      name: "Coding work",
      description: "How coding work should happen.",
    });
    const existing = await dbMocks.createGoatBrainMarkdownDocument.mock.results[0]?.value;
    dbMocks.getGoatBrainFile.mockResolvedValue(existing);
    dbMocks.updateGoatBrainFileContent.mockImplementation(async (input) => ({
      ...existing,
      ...deriveGoatBrainFileProjection({ path: "skills/coding-work.md", content: input.content }),
      updatedAt: new Date("2026-07-13T12:05:00.000Z"),
    }));

    await expect(
      updateGoatBrainSkillForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        documentId: existing.id,
        name: "Coding work",
        description: "",
        instructions: "Inspect, implement, and verify.",
      }),
    ).resolves.toMatchObject({ ok: true, document: { title: "Coding work" } });
    const input = dbMocks.updateGoatBrainFileContent.mock.calls[0]?.[0];
    expect(parseGoatBrainDocument(input.content).frontmatter).not.toHaveProperty("description");
  });

  it("rejects invalid descriptions and skill creation outside skills", async () => {
    await expect(
      createGoatBrainSkillForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        folderPath: "projects",
        name: "Coding work",
        description: "How coding work should happen.",
      }),
    ).resolves.toEqual({ ok: false, message: 'Skills must live in the "skills" folder.' });
    await expect(
      createGoatBrainSkillForUser({
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
    expect(dbMocks.createGoatBrainMarkdownDocument).not.toHaveBeenCalled();
  });

  it("keeps allocated skill ids within the native 64-character limit", async () => {
    const fullId = `s${"x".repeat(63)}`;
    dbMocks.listGoatBrainFiles.mockResolvedValueOnce([{ brainId: fullId }]);

    const result = await createGoatBrainSkillForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "skills",
      name: `s${"x".repeat(100)}`,
      description: "How coding work should happen.",
    });

    expect(result).toMatchObject({ ok: true });
    const input = dbMocks.createGoatBrainMarkdownDocument.mock.calls[0]?.[0];
    const id = parseGoatBrainDocument(input.content).frontmatter.id;
    expect(id).toHaveLength(64);
    expect(id?.endsWith("-2")).toBe(true);
  });

  it("preserves a skill description across rename and move rewrites", async () => {
    await createGoatBrainSkillForUser({
      brainRef: "goat_brain_1",
      userWorkosId: "user_1",
      folderPath: "skills",
      name: "Coding work",
      description: "How coding work should happen.",
    });
    const existing = await dbMocks.createGoatBrainMarkdownDocument.mock.results[0]?.value;
    dbMocks.getGoatBrainFile.mockResolvedValue(existing);
    dbMocks.updateGoatBrainFileContent.mockImplementation(async (input) => ({
      ...existing,
      ...deriveGoatBrainFileProjection({ path: "skills/coding-work.md", content: input.content }),
      updatedAt: new Date("2026-07-13T12:05:00.000Z"),
    }));
    dbMocks.moveGoatBrainFile.mockImplementation(async (input) => ({
      ...existing,
      ...deriveGoatBrainFileProjection({ path: input.path, content: input.content }),
      updatedAt: new Date("2026-07-13T12:10:00.000Z"),
    }));

    await expect(
      renameGoatBrainDocumentForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        documentId: existing.id,
        title: "Engineering work",
      }),
    ).resolves.toMatchObject({
      ok: true,
      document: { description: "How coding work should happen." },
    });
    const renamedContent = dbMocks.updateGoatBrainFileContent.mock.calls[0]?.[0].content;
    expect(parseGoatBrainDocument(renamedContent).frontmatter.description).toBe(
      "How coding work should happen.",
    );

    await expect(
      moveGoatBrainDocumentForUser({
        brainRef: "goat_brain_1",
        userWorkosId: "user_1",
        documentId: existing.id,
        folderPath: "skills/engineering",
      }),
    ).resolves.toMatchObject({
      ok: true,
      document: { description: "How coding work should happen." },
    });
    const movedContent = dbMocks.moveGoatBrainFile.mock.calls[0]?.[0].content;
    expect(parseGoatBrainDocument(movedContent).frontmatter.description).toBe(
      "How coding work should happen.",
    );
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
