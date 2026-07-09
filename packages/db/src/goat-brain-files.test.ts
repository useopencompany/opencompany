import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseGoatBrainDocument } from "@opencompany/goat-brain";
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
    ).resolves.toEqual({ upserted: 0, deleted: 0, conflicts: [] });
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

    expect(result).toEqual({ upserted: 1, deleted: 0, conflicts: [] });

    expect(db.transactionCount()).toBe(1);
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
