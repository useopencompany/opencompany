import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type GoatBrainEntityType,
  goatBrainEntryFromLegacyMarkdown,
  goatBrainKindForFolder,
  goatBrainSidecarRelativePath,
  serializeGoatBrainDocument,
  serializeGoatBrainPayload,
  serializeGoatBrainSidecar,
} from "@opencompany/brain";
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getWebDb: vi.fn(() => {
    throw new Error("runner Goat brain code must not use the web DB client");
  }),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: dbMocks.getWebDb,
}));

vi.mock("@opencompany/db/workspaces", () => ({
  getDefaultGoatBrainForUser: vi.fn(async () => ({
    id: "goat_brain_user_1",
    workspaceId: "goat_ws_user_1",
    name: "General",
    slug: "general",
    description: null,
    visibility: "workspace",
    createdByWorkosId: "user_1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  })),
}));

import {
  createGoatBrainMarkdownReportForTask,
  type MaterializedGoatBrainSnapshot,
  materializeGoatBrainToLocalRoot,
  syncGoatBrainFromLocalRoot,
} from "./brain";

afterEach(() => {
  vi.resetAllMocks();
});

describe("materializeGoatBrainToLocalRoot", () => {
  it("writes the bundled CLI and payload/sidecar docs to a local root", async () => {
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
        [],
      ],
    });
    dbMocks.getDb.mockReturnValue(db);

    try {
      const snapshot = await materializeGoatBrainToLocalRoot({
        root,
        userWorkosId: "user_1",
      });

      await expect(readFile(path.join(root, "research/market-map.md"), "utf8")).resolves.toBe(
        "Known market context.",
      );
      const sidecar = JSON.parse(
        await readFile(path.join(root, "research/.brain/market-map.json"), "utf8"),
      );
      expect(sidecar).toMatchObject({
        schemaVersion: "goat.brain.entry.v2",
        id: "market-map",
        folder: "research",
        payload: {
          path: "research/market-map.md",
        },
      });
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

describe("createGoatBrainMarkdownReportForTask", () => {
  it("creates a markdown report artifact in the research brain folder", async () => {
    const db = createGoatBrainDb({ selectResults: [[]] });
    dbMocks.getDb.mockReturnValue(db);

    const artifact = await createGoatBrainMarkdownReportForTask({
      userWorkosId: "user_1",
      taskId: "goat_task_1",
      taskTurnId: "goat_codex_chat_turn_1",
      title: "Fallback title",
      markdown: "# Market Report\n\nFindings.",
    });

    expect(artifact).toMatchObject({
      type: "brain_markdown_report",
      title: "Market Report",
      brainId: "market-report",
      folderPath: "research",
      brainPath: "research/market-report.md",
      url: "/brain/research/market-report",
      mimeType: "text/markdown",
    });
    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userWorkosId: "user_1",
          path: "research",
          source: "custom",
        }),
        expect.objectContaining({
          documentId: expect.any(String),
          userWorkosId: "user_1",
          brainId: "market-report",
          summary: "Created from Goat task goat_task_1.",
          evidenceId: "ev-created-from-goat-task-1",
          sourceRef: "goat-task:goat_task_1",
        }),
        expect.objectContaining({
          userWorkosId: "user_1",
          brainId: "market-report",
          folderPath: "research",
          title: "Market Report",
          body: "Findings.\n\nEvidence: [[evidence:ev-created-from-goat-task-1|Task goat_task_1]]",
          format: "markdown",
          kind: "page",
          mimeType: "text/markdown",
          sources: expect.arrayContaining([
            expect.objectContaining({
              ref: "goat-task:goat_task_1",
              title: "Task goat_task_1",
            }),
            expect.objectContaining({
              ref: "goat-task-turn:goat_codex_chat_turn_1",
              title: "Task turn goat_codex_chat_turn_1",
            }),
          ]),
          contentHash: expect.any(String),
        }),
        expect.objectContaining({
          userWorkosId: "user_1",
          fromBrainId: "market-report",
          toBrainId: "ev-created-from-goat-task-1",
          relationType: "cites",
          sourceKind: "wiki_link",
        }),
      ]),
    );
  });

  it("reuses the report already written for the same durable task turn", async () => {
    const existing = {
      ...brainRow({
        documentId: "doc_existing",
        brainId: "market-report",
        folderPath: "research",
        content: brainDoc({
          id: "market-report",
          folder: "research",
          title: "Market Report",
          truth: "Findings.",
        }),
      }),
      title: "Market Report",
      sources: [
        {
          ref: "goat-task-turn:goat_codex_chat_turn_1",
          title: "Task turn goat_codex_chat_turn_1",
          capturedAt: "2026-07-30T09:00:00.000Z",
        },
      ],
    };
    const db = createGoatBrainDb({ selectResults: [[existing]] });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      createGoatBrainMarkdownReportForTask({
        userWorkosId: "user_1",
        taskId: "goat_task_1",
        taskTurnId: "goat_codex_chat_turn_1",
        title: "Fallback title",
        markdown: "# Market Report\n\nFindings.",
      }),
    ).resolves.toMatchObject({
      documentId: "doc_existing",
      brainId: "market-report",
      brainPath: "research/market-report.md",
    });
    expect(db.insertedValues).toEqual([]);
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
            source: "custom",
          }),
          expect.objectContaining({
            userWorkosId: "user_1",
            brainId: "customer-call",
            folderPath: "meetings",
            title: "Customer call",
            content,
            body: "Customer wants a faster onboarding path.",
            contentHash: hash(content),
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects page documents placed inside the evidence zone", async () => {
    const root = await tempRoot();
    const content = serializeGoatBrainDocument({
      frontmatter: {
        id: "launch-idea",
        folder: "evidence/chat",
        kind: "page",
        type: "note",
        status: "draft",
        title: "Launch idea",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: "Launch idea",
      compiledTruth: "Launch should start with founder-led beta.",
      timeline: [],
    });
    const db = createGoatBrainDb({ selectResults: [[]] });
    dbMocks.getDb.mockReturnValue(db);

    try {
      await writeBrainFile(root, "evidence/chat/launch-idea.md", content);
      await expect(
        syncGoatBrainFromLocalRoot({
          root,
          userWorkosId: "user_1",
          taskId: "task_1",
          baseSnapshot: { files: [] },
        }),
      ).rejects.toThrow("frontmatter.folder/kind mismatch");
      expect(db.insertedValues).toEqual([]);
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
    const db = createGoatBrainDb({ selectResults: [[current], [current]] });
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
      expect(db.insertedValues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            brainId: "pricing-decision",
            folderPath: "decisions",
            content: newContent,
            body: "New pricing truth.",
            contentHash: hash(newContent),
          }),
        ]),
      );
      expect(db.insertedValues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentId: "doc_1",
            userWorkosId: "user_1",
            brainId: "pricing-decision",
            summary: "Captured in test.",
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
    const db = createGoatBrainDb({ selectResults: [[current], [current]] });
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
      expect(db.deleteWhereCalls.length).toBeGreaterThanOrEqual(1);
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
      selectResults: [[current], []],
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
            fromBrainId: expect.stringMatching(/^roadmap-conflict-/),
            toBrainId: "roadmap",
            relationType: "conflicts_with",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("syncs body and timeline changes from payload/sidecar pairs", async () => {
    const root = await tempRoot();
    const baseContent = brainDoc({
      id: "research-note",
      folder: "research",
      title: "Research note",
      truth: "Original body.",
    });
    const base = brainRow({
      documentId: "doc_1",
      brainId: "research-note",
      folderPath: "research",
      content: baseContent,
    });
    const entry = {
      ...goatBrainEntryFromLegacyMarkdown(baseContent),
      body: "Edited body.",
      timeline: [
        {
          evidenceId: "ev-sidecar-update",
          at: "2026-01-02T00:00:00.000Z",
          body: "Sidecar update.",
        },
      ],
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const db = createGoatBrainDb({ selectResults: [[base], [base]] });
    dbMocks.getDb.mockReturnValue(db);

    try {
      await writeBrainFile(root, "research/research-note.md", serializeGoatBrainPayload(entry));
      await writeBrainFile(
        root,
        goatBrainSidecarRelativePath("research", "research-note"),
        serializeGoatBrainSidecar(entry),
      );
      await syncGoatBrainFromLocalRoot({
        root,
        userWorkosId: "user_1",
        taskId: "task_1",
        baseSnapshot: snapshotFor(base),
      });

      expect(db.insertedValues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            brainId: "research-note",
            body: "Edited body.",
            timeline: [
              {
                evidenceId: "ev-sidecar-update",
                at: "2026-01-02T00:00:00.000Z",
                body: "Sidecar update.",
              },
            ],
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips an invalid sidecar without deleting the current DB doc", async () => {
    const root = await tempRoot();
    const content = brainDoc({
      id: "research-note",
      folder: "research",
      title: "Research note",
      truth: "Original body.",
    });
    const current = brainRow({
      documentId: "doc_1",
      brainId: "research-note",
      folderPath: "research",
      content,
    });
    const db = createGoatBrainDb({ selectResults: [[current]] });
    dbMocks.getDb.mockReturnValue(db);

    try {
      await writeBrainFile(root, "research/research-note.md", "Edited body.");
      await writeBrainFile(
        root,
        goatBrainSidecarRelativePath("research", "research-note"),
        JSON.stringify({ schemaVersion: "goat.brain.entry.v2", id: "research-note" }),
      );
      await expect(
        syncGoatBrainFromLocalRoot({
          root,
          userWorkosId: "user_1",
          taskId: "task_1",
          baseSnapshot: snapshotFor(current),
        }),
      ).resolves.toBeUndefined();

      expect(db.updatedValues).toEqual([]);
      expect(db.deleteWhereCalls).toEqual([]);
      expect(db.insertedValues).toEqual([]);
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
    select: vi.fn(() => {
      const rows = selectResults.shift() ?? [];
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(async () => rows),
        orderBy: vi.fn(async () => rows),
        then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertedValues.push(value);
        const chain = {
          onConflictDoUpdate: vi.fn(() => chain),
          onConflictDoNothing: vi.fn(async () => undefined),
          returning: vi.fn(async () => [
            {
              id: value.id ?? "doc_generated",
              userWorkosId: value.userWorkosId ?? "user_1",
              ...value,
              path:
                typeof value.folderPath === "string" && typeof value.brainId === "string"
                  ? `${value.folderPath}/${value.brainId}.md`
                  : undefined,
              createdAt: value.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: value.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
            },
          ]),
        };
        return chain;
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updatedValues.push(value);
        const chain = {
          where: vi.fn(() => chain),
          returning: vi.fn(async () => [
            {
              id: "doc_1",
              userWorkosId: "user_1",
              ...value,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: value.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
            },
          ]),
        };
        return chain;
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
      kind: goatBrainKindForFolder(input.folder),
      type: typeForTestFolder(input.folder),
      status: "draft",
      title: input.title,
      createdAt: at,
      updatedAt: at,
      relations: [],
    },
    title: input.title,
    compiledTruth: input.truth,
    timeline: [{ evidenceId: "ev-captured-in-test", at, body: "Captured in test." }],
  });
}

function typeForTestFolder(folder: string): GoatBrainEntityType {
  const root = folder.split("/")[0];
  if (root === "research") return "analysis";
  if (root === "projects") return "project";
  return "note";
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
    brainRef: "goat_brain_user_1",
    brainId: input.brainId,
    folderPath: input.folderPath,
    title: input.brainId,
    content: input.content,
    body: goatBrainEntryFromLegacyMarkdown(input.content).body,
    timeline: goatBrainEntryFromLegacyMarkdown(input.content).timeline,
    format: "markdown",
    mimeType: "text/markdown",
    originalFileName: null,
    assetStorageKey: null,
    relations: [],
    sources: [],
    kind: goatBrainKindForFolder(input.folderPath),
    entityType: typeForTestFolder(input.folderPath),
    status: "draft",
    aliases: [],
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
