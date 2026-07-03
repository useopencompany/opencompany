import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeGoatBrainDocument } from "@opencompany/goat-brain";
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

import {
  type MaterializedGoatBrainSnapshot,
  materializeGoatBrainToLocalRoot,
  syncGoatBrainFromLocalRoot,
} from "./goat-brain";

afterEach(() => {
  vi.resetAllMocks();
});

describe("materializeGoatBrainToLocalRoot", () => {
  it("writes the bundled CLI and current markdown docs to a local root", async () => {
    const root = await tempRoot();
    const content = brainDoc({
      id: "market-map",
      folder: "research",
      title: "Market map",
      truth: "Known market context.",
    });
    const db = createGoatBrainDb({
      selectResults: [
        [
          brainRow({
            documentId: "doc_1",
            brainId: "market-map",
            folderPath: "research",
            content,
          }),
        ],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);

    try {
      const snapshot = await materializeGoatBrainToLocalRoot({
        root,
        userWorkosId: "user_1",
      });

      await expect(readFile(path.join(root, "research/market-map.md"), "utf8")).resolves.toBe(
        content,
      );
      await expect(readFile(snapshot.cliPath, "utf8")).resolves.toContain("goat-brain");
      expect(snapshot.files).toEqual([
        expect.objectContaining({
          documentId: "doc_1",
          brainId: "market-map",
          folderPath: "research",
          relativePath: "research/market-map.md",
          contentHash: hash(content),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("syncGoatBrainFromLocalRoot", () => {
  it("inserts a new valid sandbox doc and ensures its folder", async () => {
    const root = await tempRoot();
    const content = brainDoc({
      id: "customer-call",
      folder: "meetings",
      title: "Customer call",
      truth: "Customer wants a faster onboarding path.",
    });
    const db = createGoatBrainDb({ selectResults: [[]] });
    dbMocks.getDb.mockReturnValue(db);

    try {
      await writeBrainFile(root, "meetings/customer-call.md", content);
      await syncGoatBrainFromLocalRoot({
        root,
        userWorkosId: "user_1",
        taskId: "task_1",
        baseSnapshot: { files: [] },
      });

      expect(db.insertedValues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userWorkosId: "user_1",
            path: "meetings",
            source: "system",
          }),
          expect.objectContaining({
            userWorkosId: "user_1",
            brainId: "customer-call",
            folderPath: "meetings",
            title: "Customer call",
            content,
            contentHash: hash(content),
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("versions and updates an unchanged live DB doc when sandbox content changed", async () => {
    const root = await tempRoot();
    const oldContent = brainDoc({
      id: "pricing-decision",
      folder: "decisions",
      title: "Pricing decision",
      truth: "Old pricing truth.",
    });
    const newContent = brainDoc({
      id: "pricing-decision",
      folder: "decisions",
      title: "Pricing decision",
      truth: "New pricing truth.",
    });
    const current = brainRow({
      documentId: "doc_1",
      brainId: "pricing-decision",
      folderPath: "decisions",
      content: oldContent,
    });
    const db = createGoatBrainDb({ selectResults: [[current]] });
    dbMocks.getDb.mockReturnValue(db);

    try {
      await writeBrainFile(root, "decisions/pricing-decision.md", newContent);
      await syncGoatBrainFromLocalRoot({
        root,
        userWorkosId: "user_1",
        taskId: "task_1",
        baseSnapshot: snapshotFor(current),
      });

      expect(db.insertedValues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentId: "doc_1",
            taskId: "task_1",
            brainId: "pricing-decision",
            content: oldContent,
            operation: "overwrite",
          }),
        ]),
      );
      expect(db.updatedValues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            brainId: "pricing-decision",
            folderPath: "decisions",
            content: newContent,
            contentHash: hash(newContent),
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("versions and deletes a base doc removed from the sandbox", async () => {
    const root = await tempRoot();
    const content = brainDoc({
      id: "old-note",
      folder: "inbox",
      title: "Old note",
      truth: "Remove me.",
    });
    const current = brainRow({
      documentId: "doc_1",
      brainId: "old-note",
      folderPath: "inbox",
      content,
    });
    const db = createGoatBrainDb({ selectResults: [[current]] });
    dbMocks.getDb.mockReturnValue(db);

    try {
      await syncGoatBrainFromLocalRoot({
        root,
        userWorkosId: "user_1",
        taskId: "task_1",
        baseSnapshot: snapshotFor(current),
      });

      expect(db.insertedValues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentId: "doc_1",
            taskId: "task_1",
            brainId: "old-note",
            content,
            operation: "delete",
          }),
        ]),
      );
      expect(db.deleteWhereCalls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a concurrent live edit by writing sandbox changes as a conflict doc", async () => {
    const root = await tempRoot();
    const baseContent = brainDoc({
      id: "roadmap",
      folder: "projects",
      title: "Roadmap",
      truth: "Base truth.",
    });
    const liveContent = brainDoc({
      id: "roadmap",
      folder: "projects",
      title: "Roadmap",
      truth: "Live DB truth.",
    });
    const sandboxContent = brainDoc({
      id: "roadmap",
      folder: "projects",
      title: "Roadmap",
      truth: "Sandbox truth.",
    });
    const base = brainRow({
      documentId: "doc_1",
      brainId: "roadmap",
      folderPath: "projects",
      content: baseContent,
    });
    const current = {
      ...base,
      content: liveContent,
      contentHash: hash(liveContent),
    };
    const db = createGoatBrainDb({
      selectResults: [[current], [{ brainId: "roadmap" }]],
    });
    dbMocks.getDb.mockReturnValue(db);

    try {
      await writeBrainFile(root, "projects/roadmap.md", sandboxContent);
      await syncGoatBrainFromLocalRoot({
        root,
        userWorkosId: "user_1",
        taskId: "task_1",
        baseSnapshot: snapshotFor(base),
      });

      const conflictInsert = db.insertedValues.find(
        (value) =>
          typeof value.brainId === "string" && value.brainId.startsWith("roadmap-conflict-"),
      );
      expect(conflictInsert).toMatchObject({
        userWorkosId: "user_1",
        folderPath: "projects",
        title: "Roadmap conflict",
      });
      expect(String(conflictInsert?.content)).toContain("conflicts_with");
      expect(String(conflictInsert?.content)).toContain("Sandbox truth.");
      expect(db.updatedValues).toEqual([]);
      expect(db.insertedValues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: "task_1",
            brainId: "roadmap",
            content: sandboxContent,
            operation: "overwrite",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createGoatBrainDb(input: { selectResults: unknown[][] }) {
  const selectResults = [...input.selectResults];
  const insertedValues: Array<Record<string, unknown>> = [];
  const updatedValues: Array<Record<string, unknown>> = [];
  const deleteWhereCalls: unknown[] = [];
  const db = {
    insertedValues,
    updatedValues,
    deleteWhereCalls,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => selectResults.shift() ?? []),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertedValues.push(value);
        return {
          onConflictDoUpdate: vi.fn(async () => undefined),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updatedValues.push(value);
        return {
          where: vi.fn(async (whereInput: unknown) => whereInput),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async (whereInput: unknown) => {
        deleteWhereCalls.push(whereInput);
      }),
    })),
    transaction: vi.fn(async (callback: (tx: typeof db) => unknown) => callback(db)),
  };
  return db;
}

function brainDoc(input: { id: string; folder: string; title: string; truth: string }) {
  const at = "2026-01-01T00:00:00.000Z";
  return serializeGoatBrainDocument({
    frontmatter: {
      id: input.id,
      folder: input.folder,
      title: input.title,
      createdAt: at,
      updatedAt: at,
      related: [],
    },
    title: input.title,
    compiledTruth: input.truth,
    timeline: [{ at, body: "Captured in test." }],
  });
}

function brainRow(input: {
  documentId: string;
  brainId: string;
  folderPath: string;
  content: string;
}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: input.documentId,
    userWorkosId: "user_1",
    brainId: input.brainId,
    folderPath: input.folderPath,
    title: input.brainId,
    content: input.content,
    related: [],
    sources: [],
    contentHash: hash(input.content),
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
    createdAt: now,
    updatedAt: now,
  };
}

function snapshotFor(row: ReturnType<typeof brainRow>): MaterializedGoatBrainSnapshot {
  return {
    files: [
      {
        documentId: row.id,
        brainId: row.brainId,
        folderPath: row.folderPath,
        relativePath: `${row.folderPath}/${row.brainId}.md`,
        contentHash: row.contentHash,
      },
    ],
  };
}

async function writeBrainFile(root: string, relativePath: string, content: string) {
  const fullPath = path.join(root, relativePath);
  await writeFile(fullPath, content, "utf8").catch(async (error: unknown) => {
    if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") {
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(path.dirname(fullPath), { recursive: true }),
      );
      await writeFile(fullPath, content, "utf8");
      return;
    }
    throw error;
  });
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "goat-brain-test-"));
}

function hash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
