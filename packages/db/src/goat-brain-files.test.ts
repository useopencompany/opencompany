import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendGoatBrainAssetTextBlock,
  GOAT_BRAIN_FOLDER_MANIFEST_PATH,
  parseGoatBrainDocument,
  parseGoatBrainFolderManifest,
} from "@opencompany/goat-brain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGoatBrainMarkdownContent,
  deriveGoatBrainFileProjection,
  hashGoatBrainContent,
  materializeGoatBrainFilesToRoot,
  readGoatBrainFilesFromRoot,
  syncGoatBrainFiles,
} from "./goat-brain-files";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "goat-brain-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("goat brain file sync", () => {
  it("projects evidence kind from the evidence zone folder", () => {
    const content = createGoatBrainMarkdownContent({
      id: "ev-acme-email",
      folderPath: "evidence/email",
      title: "Acme email",
      type: "source",
      status: "active",
      compiledTruth: "Acme asked for enterprise pricing.",
    });

    expect(
      deriveGoatBrainFileProjection({
        path: "evidence/email/ev-acme-email.md",
        content,
      }),
    ).toMatchObject({
      brainId: "ev-acme-email",
      folderPath: "evidence/email",
      kind: "evidence",
      entityType: "source",
    });
  });

  it("projects pages outside the evidence zone with kind page", () => {
    const content = createGoatBrainMarkdownContent({
      id: "ada",
      folderPath: "team/gtm",
      title: "Ada",
      type: "person",
      status: "draft",
      compiledTruth: "Ada leads GTM.",
    });

    expect(deriveGoatBrainFileProjection({ path: "team/gtm/ada.md", content })).toMatchObject({
      brainId: "ada",
      folderPath: "team/gtm",
      kind: "page",
      entityType: "person",
    });
  });

  it("preserves skill descriptions in the database projection", () => {
    const content = createGoatBrainMarkdownContent({
      id: "coding-work",
      folderPath: "skills",
      title: "Coding work",
      description: "How coding work should happen.",
      type: "note",
      status: "draft",
      compiledTruth: "Inspect, implement, and verify.",
    });

    const projection = deriveGoatBrainFileProjection({
      path: "skills/coding-work.md",
      content,
    });
    expect(projection).toMatchObject({
      brainId: "coding-work",
      folderPath: "skills",
      description: "How coding work should happen.",
    });
    expect(parseGoatBrainDocument(projection.content).frontmatter.description).toBe(
      "How coding work should happen.",
    );
  });

  it("preserves skill descriptions through materialization", async () => {
    const content = createGoatBrainMarkdownContent({
      id: "coding-work",
      folderPath: "skills",
      title: "Coding work",
      description: "How coding work should happen.",
      type: "note",
      status: "draft",
      compiledTruth: "Inspect, implement, and verify.",
    });
    const db = materializeSelectDb([
      {
        id: "doc_1",
        userWorkosId: "user_1",
        brainRef: "goat_brain_user_1",
        brainId: "coding-work",
        folderPath: "skills",
        content,
        contentHash: hashGoatBrainContent(content),
        format: "markdown",
      },
    ]);

    await materializeGoatBrainFilesToRoot({ brainRef: "goat_brain_user_1", root, db });
    const files = await readGoatBrainFilesFromRoot(root);

    expect(files).toEqual([{ path: "skills/coding-work.md", content }]);
    expect(parseGoatBrainDocument(files[0]!.content).frontmatter.description).toBe(
      "How coding work should happen.",
    );
  });

  it("projects nested legacy markdown compiled truth as body-only text", () => {
    const nested = createGoatBrainMarkdownContent({
      id: "nested-note",
      folderPath: "inbox",
      title: "Nested note",
      type: "note",
      status: "draft",
      compiledTruth: "Only this truth should be stored as the body.",
    });
    const content = [
      "---",
      "id: brain-native-background-workers",
      "folder: product/concepts",
      "kind: page",
      "type: note",
      "status: draft",
      "title: Brain-native background workers",
      "createdAt: 2026-01-01T00:00:00.000Z",
      "updatedAt: 2026-01-01T00:00:00.000Z",
      "related: []",
      "---",
      "",
      "# Brain-native background workers",
      "",
      "## Compiled truth",
      nested,
      "",
      "<!-- TIMELINE:BELOW - append only past this marker -->",
      "",
      "## Timeline",
      "",
    ].join("\n");

    const projection = deriveGoatBrainFileProjection({
      path: "product/concepts/brain-native-background-workers.md",
      content,
    });

    expect(projection).toMatchObject({
      body: "Only this truth should be stored as the body.",
    });
    expect(parseGoatBrainDocument(projection.content).compiledTruth).toBe(projection.body);
    expect(projection.content).not.toContain("id: nested-note");
  });

  it("projects compiled truth without a duplicate leading title heading", () => {
    const content = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "# Acme\n\nAcme evaluates Goat Brain.",
    });

    const projection = deriveGoatBrainFileProjection({
      path: "companies/acme.md",
      content,
    });

    expect(projection.body).toBe("Acme evaluates Goat Brain.");
    expect(parseGoatBrainDocument(projection.content).compiledTruth).toBe(projection.body);
  });

  it("recovers sidecar-backed markdown when only the payload hash is stale", async () => {
    await writeSidecarBackedPayload({
      relativePath: "companies/acme.md",
      payload: "Acme now evaluates Goat Brain.",
      sidecar: {
        schemaVersion: "goat.brain.entry.v2",
        id: "acme",
        folder: "companies",
        title: "Acme",
        format: "markdown",
        kind: "page",
        mimeType: "text/markdown",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
        sources: [],
        type: "company",
        status: "draft",
        timeline: [],
        payload: {
          path: "companies/acme.md",
          sha256: "stale",
          sizeBytes: 1,
        },
      },
    });

    const files = await readGoatBrainFilesFromRoot(root);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "companies/acme.md" });
    expect(files[0]?.skip).toBeUndefined();
    expect(files[0]?.content).toContain("id: acme");
    expect(files[0]?.content).toContain("# Acme");
    expect(files[0]?.content).toContain("Acme now evaluates Goat Brain.");
  });

  it("skips unrecoverable sidecar-backed markdown instead of throwing", async () => {
    await writeSidecarBackedPayload({
      relativePath: "competitors/rivalco-competitor.md",
      payload: "",
      sidecar: {
        schemaVersion: "goat.brain.entry.v2",
        id: "rivalco-competitor",
        folder: "competitors",
        title: "",
        format: "markdown",
        kind: "page",
        mimeType: "text/markdown",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
        sources: [],
        type: "company",
        status: "draft",
        timeline: [],
        payload: {
          path: "competitors/rivalco-competitor.md",
          sha256: "stale",
          sizeBytes: 1,
        },
      },
    });

    await expect(readGoatBrainFilesFromRoot(root)).resolves.toEqual([
      { path: "competitors/rivalco-competitor.md", content: "", skip: true },
    ]);
  });

  it("does not validate unchanged invalid files during sync", async () => {
    const content = "---\n---\n";
    const contentHash = hashGoatBrainContent(content);
    const db = syncSelectOnlyDb([
      {
        id: "doc_1",
        userWorkosId: "user_1",
        brainRef: "goat_brain_user_1",
        brainId: "rivalco-competitor",
        folderPath: "competitors",
        contentHash,
      },
    ]);

    await expect(
      syncGoatBrainFiles({
        brainRef: "goat_brain_user_1",
        userWorkosId: "user_1",
        files: [{ path: "competitors/rivalco-competitor.md", content }],
        baseSnapshot: [
          {
            id: "doc_1",
            brainId: "rivalco-competitor",
            folderPath: "competitors",
            path: "competitors/rivalco-competitor.md",
            contentHash,
          },
        ],
        db,
      }),
    ).resolves.toEqual({ upserted: 0, deleted: 0, conflicts: [], pages: [] });
  });

  it("reports newly created page descriptors from sync", async () => {
    const content = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Acme is evaluating Goat Brain.",
    });
    const db = syncMutableDb([]);

    const result = await syncGoatBrainFiles({
      brainRef: "goat_brain_user_1",
      userWorkosId: "user_1",
      files: [{ path: "companies/acme.md", content }],
      baseSnapshot: [],
      db,
    });

    expect(result).toMatchObject({
      upserted: 1,
      deleted: 0,
      conflicts: [],
      pages: [
        {
          brainId: "acme",
          folderPath: "companies",
          title: "Acme",
          action: "created",
        },
      ],
    });
  });

  it("keeps a moved brain file by matching on stable brain id", async () => {
    const oldContent = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Acme is an existing account.",
    });
    const newContent = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies/customers",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Acme is now a customer.",
    });
    const current = {
      id: "doc_1",
      userWorkosId: "user_1",
      brainRef: "goat_brain_user_1",
      brainId: "acme",
      folderPath: "companies",
      content: oldContent,
      contentHash: hashGoatBrainContent(oldContent),
      sizeBytes: Buffer.byteLength(oldContent, "utf8"),
      title: "Acme",
      entityType: "company",
      status: "draft",
    };
    const db = syncMutableDb([current]);

    const result = await syncGoatBrainFiles({
      brainRef: "goat_brain_user_1",
      userWorkosId: "user_1",
      files: [{ path: "companies/customers/acme.md", content: newContent }],
      baseSnapshot: [
        {
          id: "doc_1",
          brainId: "acme",
          folderPath: "companies",
          path: "companies/acme.md",
          contentHash: hashGoatBrainContent(oldContent),
        },
      ],
      db,
    });

    expect(result).toEqual({
      upserted: 1,
      deleted: 0,
      conflicts: [],
      pages: [
        {
          brainId: "acme",
          folderPath: "companies/customers",
          title: "Acme",
          action: "updated",
        },
      ],
    });

    expect(db.transactionCount()).toBe(1);
  });

  it("reports conflict-created page descriptors from handled sync conflicts", async () => {
    const baseContent = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Base.",
    });
    const currentContent = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Current changed independently.",
    });
    const nextContent = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Agent changed the same page.",
    });
    const db = syncMutableDb([
      {
        id: "doc_1",
        userWorkosId: "user_1",
        brainRef: "goat_brain_user_1",
        brainId: "acme",
        folderPath: "companies",
        content: currentContent,
        contentHash: hashGoatBrainContent(currentContent),
        sizeBytes: Buffer.byteLength(currentContent, "utf8"),
        title: "Acme",
        kind: "page",
        entityType: "company",
        status: "draft",
      },
    ]);

    const result = await syncGoatBrainFiles({
      brainRef: "goat_brain_user_1",
      userWorkosId: "user_1",
      files: [{ path: "companies/acme.md", content: nextContent }],
      baseSnapshot: [
        {
          id: "doc_1",
          brainId: "acme",
          folderPath: "companies",
          path: "companies/acme.md",
          contentHash: hashGoatBrainContent(baseContent),
        },
      ],
      db,
    });

    expect(result.upserted).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      folderPath: "companies",
      title: "Acme conflict",
      action: "conflict_created",
    });
    expect(result.pages[0]?.brainId).toMatch(/^acme-conflict-/);
  });

  it("does not conflict on concurrently changed files the sync leaves untouched", async () => {
    const baseContent = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Base.",
    });
    const currentContent = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Current changed independently.",
    });
    const otherContent = createGoatBrainMarkdownContent({
      id: "ada",
      folderPath: "people",
      title: "Ada",
      type: "person",
      status: "draft",
      compiledTruth: "Agent wrote an unrelated page.",
    });
    const db = syncMutableDb([
      {
        id: "doc_1",
        userWorkosId: "user_1",
        brainRef: "goat_brain_user_1",
        brainId: "acme",
        folderPath: "companies",
        content: currentContent,
        contentHash: hashGoatBrainContent(currentContent),
        sizeBytes: Buffer.byteLength(currentContent, "utf8"),
        title: "Acme",
        kind: "page",
        entityType: "company",
        status: "draft",
      },
    ]);

    // The agent never touched companies/acme.md (its root copy still matches the
    // base snapshot), so the concurrent stored change must not abort the sync.
    const result = await syncGoatBrainFiles({
      brainRef: "goat_brain_user_1",
      userWorkosId: "user_1",
      files: [
        { path: "companies/acme.md", content: baseContent },
        { path: "people/ada.md", content: otherContent },
      ],
      baseSnapshot: [
        {
          id: "doc_1",
          brainId: "acme",
          folderPath: "companies",
          path: "companies/acme.md",
          contentHash: hashGoatBrainContent(baseContent),
        },
      ],
      db,
    });

    expect(result.conflicts).toEqual([]);
    expect(result.deleted).toBe(0);
    expect(result.upserted).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({ brainId: "ada", action: "created" });
  });

  it("still aborts when a concurrently changed file was deleted by the sync", async () => {
    const baseContent = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Base.",
    });
    const currentContent = createGoatBrainMarkdownContent({
      id: "acme",
      folderPath: "companies",
      title: "Acme",
      type: "company",
      status: "draft",
      compiledTruth: "Current changed independently.",
    });
    const db = syncMutableDb([
      {
        id: "doc_1",
        userWorkosId: "user_1",
        brainRef: "goat_brain_user_1",
        brainId: "acme",
        folderPath: "companies",
        content: currentContent,
        contentHash: hashGoatBrainContent(currentContent),
        sizeBytes: Buffer.byteLength(currentContent, "utf8"),
        title: "Acme",
        kind: "page",
        entityType: "company",
        status: "draft",
      },
    ]);

    const result = await syncGoatBrainFiles({
      brainRef: "goat_brain_user_1",
      userWorkosId: "user_1",
      files: [],
      baseSnapshot: [
        {
          id: "doc_1",
          brainId: "acme",
          folderPath: "companies",
          path: "companies/acme.md",
          contentHash: hashGoatBrainContent(baseContent),
        },
      ],
      db,
    });

    expect(result.conflicts).toEqual([
      { path: "companies/acme.md", reason: "changed_since_materialize" },
    ]);
    expect(result.upserted).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it("treats replaced asset bytes as a concurrent change to a deleted projection", async () => {
    const content = createGoatBrainMarkdownContent({
      id: "plan",
      folderPath: "inbox",
      title: "Plan",
      type: "source",
      status: "draft",
      compiledTruth: "Uploaded plan.",
    });
    const db = syncSelectOnlyDb([
      {
        id: "document_1",
        userWorkosId: "user_1",
        brainRef: "goat_brain_user_1",
        brainId: "plan",
        folderPath: "inbox",
        content,
        contentHash: hashGoatBrainContent(content),
        assetContentHash: "b".repeat(64),
      },
    ]);

    const result = await syncGoatBrainFiles({
      brainRef: "goat_brain_user_1",
      userWorkosId: "user_1",
      files: [],
      baseSnapshot: [
        {
          id: "document_1",
          brainId: "plan",
          folderPath: "inbox",
          path: "inbox/plan.md",
          contentHash: hashGoatBrainContent(content),
          assetContentHash: "a".repeat(64),
        },
      ],
      db,
    });

    expect(result).toEqual({
      upserted: 0,
      deleted: 0,
      conflicts: [{ path: "inbox/plan.md", reason: "changed_since_materialize" }],
      pages: [],
    });
  });

  it("materializes invalid stored markdown as a raw file that can be deleted", async () => {
    const content = "---\n---\n";
    const db = materializeSelectDb([
      {
        id: "doc_1",
        userWorkosId: "user_1",
        brainRef: "goat_brain_user_1",
        brainId: "rivalco-competitor",
        folderPath: "competitors",
        content,
        contentHash: hashGoatBrainContent(content),
      },
    ]);

    await expect(
      materializeGoatBrainFilesToRoot({ brainRef: "goat_brain_user_1", root, db }),
    ).resolves.toEqual([
      {
        id: "doc_1",
        brainId: "rivalco-competitor",
        path: "competitors/rivalco-competitor.md",
        folderPath: "competitors",
        contentHash: hashGoatBrainContent(content),
      },
    ]);
    await expect(readGoatBrainFilesFromRoot(root)).resolves.toEqual([
      { path: "competitors/rivalco-competitor.md", content },
    ]);
  });

  it("materializes persistent folder rows into the folder manifest", async () => {
    const db = queuedSelectDb([
      [],
      [
        folderRow({ path: "research", source: "custom" }),
        folderRow({ path: "people", source: "system" }),
      ],
    ]);

    await materializeGoatBrainFilesToRoot({ brainRef: "goat_brain_user_1", root, db });

    const folders = parseGoatBrainFolderManifest(
      await readFile(path.join(root, GOAT_BRAIN_FOLDER_MANIFEST_PATH), "utf8"),
    );
    expect(folders).toEqual(
      expect.arrayContaining([
        { path: "inbox", source: "system" },
        { path: "research", source: "custom" },
        { path: "people", source: "system" },
        { path: "companies", source: "system" },
        { path: "evidence", source: "system" },
      ]),
    );
    expect(folders.map((folder) => folder.path)).not.toContain("analysis");
  });

  it("syncs folder manifest rows and normalizes adjustable sources", async () => {
    const db = folderSyncDb();

    await syncGoatBrainFiles({
      brainRef: "goat_brain_user_1",
      userWorkosId: "user_1",
      files: [],
      baseSnapshot: [],
      folders: [
        { path: "research", source: "system" },
        { path: "partners", source: "custom" },
      ],
      db: db as never,
    });

    expect(db.insertedFolders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "inbox", source: "system" }),
        expect.objectContaining({ path: "research", source: "custom" }),
        expect.objectContaining({ path: "partners", source: "custom" }),
        expect.objectContaining({ path: "people", source: "system" }),
        expect.objectContaining({ path: "companies", source: "system" }),
        expect.objectContaining({ path: "evidence", source: "system" }),
      ]),
    );
  });
});

async function writeSidecarBackedPayload(input: {
  relativePath: string;
  payload: string;
  sidecar: Record<string, unknown>;
}) {
  const target = path.join(root, input.relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, input.payload, "utf8");
  const id = path.basename(input.relativePath, ".md");
  const sidecarPath = path.join(root, path.dirname(input.relativePath), ".brain", `${id}.json`);
  await mkdir(path.dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, `${JSON.stringify(input.sidecar, null, 2)}\n`, "utf8");
}

function syncSelectOnlyDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as never;
}

function syncMutableDb(rows: Record<string, unknown>[]) {
  let transactions = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows.slice(0, 1),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const existing = rows.find((row) => row.brainId === values.brainId);
            const next = { ...existing, ...values };
            if (existing) Object.assign(existing, next);
            else rows.push(next);
            return [next];
          },
        }),
        onConflictDoNothing: async () => undefined,
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
  };
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
    transaction: async (run: (transaction: unknown) => Promise<unknown>) => {
      transactions += 1;
      return run(tx);
    },
    transactionCount: () => transactions,
  };
}

function materializeSelectDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  } as never;
}

function queuedSelectDb(results: unknown[][]) {
  const queue = [...results];
  return {
    select: () => {
      const rows = queue.shift() ?? [];
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: async () => rows,
        then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  } as never;
}

function folderSyncDb() {
  let selectCount = 0;
  const insertedFolders: Record<string, unknown>[] = [];
  return {
    select: () => {
      selectCount += 1;
      const rows = selectCount === 1 ? [] : insertedFolders;
      const chain = {
        from: () => chain,
        where: () => chain,
        then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertedFolders.push(values);
        return {
          onConflictDoUpdate: async () => undefined,
          onConflictDoNothing: async () => undefined,
        };
      },
    }),
    delete: () => ({
      where: async () => undefined,
    }),
    insertedFolders: () => insertedFolders,
  };
}

function folderRow(input: { path: string; source: "system" | "custom" }) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: `folder_${input.path}`,
    userWorkosId: "user_1",
    brainRef: "goat_brain_user_1",
    path: input.path,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
}

describe("goat brain asset projections", () => {
  it("strips the generated extracted-text block before persisting", () => {
    const content = createGoatBrainMarkdownContent({
      id: "q3-board-deck",
      folderPath: "sources",
      title: "Q3 Board Deck",
      type: "source",
      compiledTruth: "Uploaded file `deck.pdf`. Ingestion pending.",
    });
    const projected = appendGoatBrainAssetTextBlock(content, "Revenue grew 40% QoQ.");

    const projection = deriveGoatBrainFileProjection({
      path: "sources/q3-board-deck.md",
      content: projected,
    });

    expect(projection.content).toBe(content);
    expect(projection.contentHash).toBe(hashGoatBrainContent(content));
    expect(projection.body).not.toContain("Revenue grew 40%");
  });

  it("discards edits made inside the generated block", () => {
    const content = createGoatBrainMarkdownContent({
      id: "q3-board-deck",
      folderPath: "sources",
      title: "Q3 Board Deck",
      type: "source",
      compiledTruth: "Synthesis.",
    });
    const tampered = appendGoatBrainAssetTextBlock(content, "original text").replace(
      "original text",
      "tampered text",
    );

    const projection = deriveGoatBrainFileProjection({
      path: "sources/q3-board-deck.md",
      content: tampered,
    });

    expect(projection.content).toBe(content);
  });
});
