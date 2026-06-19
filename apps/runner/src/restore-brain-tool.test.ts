import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));
const eventMocks = vi.hoisted(() => ({
  appendRuntimeEvent: vi.fn(async () => {}),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));
vi.mock("./events", () => eventMocks);

import { runRestoreBrainTool } from "./restore-brain-tool";

afterEach(() => {
  vi.resetAllMocks();
});

describe("runRestoreBrainTool", () => {
  it("company restore records the prior content, upserts the brain row, enqueues a brain sync, and emits an event", async () => {
    const db = createRestoreDb({
      versions: [
        {
          id: 7,
          scope: "company",
          agentId: null,
          path: "docs/notes.md",
          content: "Version A",
          contentHash: "hash_a",
          sizeBytes: 9,
          operation: "overwrite",
          sessionId: "ses_old",
          createdAt: new Date("2026-06-10T00:00:00Z"),
        },
      ],
      current: {
        path: "docs/notes.md",
        content: "Live content",
        contentHash: "hash_live",
        sizeBytes: 12,
      },
    });
    dbMocks.getDb.mockReturnValue(db);

    const result = (await runRestoreBrainTool({
      sessionId: "ses_now",
      workspaceId: "wsp_123",
      agentId: undefined,
      personalAgent: false,
      args: { path: "docs/notes.md" },
    })) as { ok: boolean; scope: string };

    expect(result.ok).toBe(true);
    expect(result.scope).toBe("company");

    // The displaced live bytes are preserved as a recoverable "overwrite" version first.
    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "company",
          agentId: null,
          path: "docs/notes.md",
          content: "Live content",
          operation: "overwrite",
          sessionId: "ses_now",
        }),
        // The canonical brain row is overwritten with the restored content.
        expect.objectContaining({
          workspaceId: "wsp_123",
          path: "docs/notes.md",
          content: "Version A",
          contentHash: "hash_a",
          githubSyncStatus: "pending",
        }),
        // A workspace sync job is enqueued for the company brain path.
        expect.objectContaining({
          workspaceId: "wsp_123",
          repoPath: "brain/docs/notes.md",
          sourceKind: "brain",
          operation: "upsert",
          desiredHash: "hash_a",
        }),
      ]),
    );
    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sessionId: "ses_now",
        type: "brain.file_changed",
      }),
    );
  });

  it("personal restore writes the agent_file scope and enqueues an agent_file sync", async () => {
    const db = createRestoreDb({
      versions: [
        {
          id: 3,
          scope: "personal",
          agentId: "agt_1",
          path: "agents/me/personal-brain/journal.md",
          content: "Saved journal",
          contentHash: "hash_saved",
          sizeBytes: 13,
          operation: "delete",
          sessionId: "ses_old",
          createdAt: new Date("2026-06-11T00:00:00Z"),
        },
      ],
      current: null, // file was deleted; restore re-creates it
    });
    dbMocks.getDb.mockReturnValue(db);

    const result = (await runRestoreBrainTool({
      sessionId: "ses_now",
      workspaceId: "wsp_123",
      agentId: "agt_1",
      personalAgent: true,
      args: { path: "agents/me/personal-brain/journal.md" },
    })) as { ok: boolean; scope: string };

    expect(result.ok).toBe(true);
    expect(result.scope).toBe("personal");

    expect(db.insertedValues).toEqual(
      expect.arrayContaining([
        // The restored agent file row, keyed by its full repo path and owning agent.
        expect.objectContaining({
          workspaceId: "wsp_123",
          agentId: "agt_1",
          path: "agents/me/personal-brain/journal.md",
          content: "Saved journal",
          contentHash: "hash_saved",
          githubSyncStatus: "pending",
        }),
        // The sync job uses the agent_file source kind with the full repo path.
        expect.objectContaining({
          workspaceId: "wsp_123",
          repoPath: "agents/me/personal-brain/journal.md",
          sourceKind: "agent_file",
          operation: "upsert",
          desiredHash: "hash_saved",
        }),
      ]),
    );
    // No "overwrite" backup row is written because the file was deleted (no live content).
    expect(db.insertedValues.some((value) => value.operation === "overwrite")).toBe(false);
    expect(eventMocks.appendRuntimeEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sessionId: "ses_now",
        type: "agent_bundle.file_changed",
      }),
    );
  });

  it("returns a recoverable error for a personal restore with no agent context", async () => {
    const db = createRestoreDb({ versions: [], current: null });
    dbMocks.getDb.mockReturnValue(db);

    const result = (await runRestoreBrainTool({
      sessionId: "ses_now",
      workspaceId: "wsp_123",
      agentId: undefined,
      personalAgent: true,
      args: { path: "agents/me/personal-brain/journal.md" },
    })) as { ok: boolean; error?: { code: string; recoverable: boolean } };

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("missing_agent");
    expect(result.error?.recoverable).toBe(true);
    // Nothing is written and no event is emitted on the error path.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(eventMocks.appendRuntimeEvent).not.toHaveBeenCalled();
  });

  it("list_only returns the saved versions without writing anything", async () => {
    const db = createRestoreDb({
      versions: [
        {
          id: 12,
          scope: "company",
          agentId: null,
          path: "docs/notes.md",
          content: "Newest",
          contentHash: "hash_new",
          sizeBytes: 6,
          operation: "overwrite",
          sessionId: "ses_b",
          createdAt: new Date("2026-06-12T00:00:00Z"),
        },
        {
          id: 5,
          scope: "company",
          agentId: null,
          path: "docs/notes.md",
          content: "Older",
          contentHash: "hash_old",
          sizeBytes: 5,
          operation: "delete",
          sessionId: "ses_a",
          createdAt: new Date("2026-06-10T00:00:00Z"),
        },
      ],
      current: null,
    });
    dbMocks.getDb.mockReturnValue(db);

    const result = (await runRestoreBrainTool({
      sessionId: "ses_now",
      workspaceId: "wsp_123",
      agentId: undefined,
      personalAgent: false,
      args: { path: "docs/notes.md", list_only: true },
    })) as {
      ok: boolean;
      versions: Array<{ id: number; operation: string; sizeBytes: number }>;
    };

    expect(result.ok).toBe(true);
    expect(result.versions).toEqual([
      expect.objectContaining({ id: 12, operation: "overwrite", sizeBytes: 6 }),
      expect.objectContaining({ id: 5, operation: "delete", sizeBytes: 5 }),
    ]);
    // list_only is read-only: no transaction, no inserts, no event.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.insertedValues).toHaveLength(0);
    expect(eventMocks.appendRuntimeEvent).not.toHaveBeenCalled();
  });
});

// Mock db harness mirroring brain.test.ts: a `select().from().where()` chain that resolves to the
// version list via `.orderBy(...)` and to the current live row via `.limit(...)`, plus an
// insert-recording `insert().values().onConflictDoUpdate()` chain and a pass-through transaction.
function createRestoreDb(input: {
  versions: Array<Record<string, unknown>>;
  current: Record<string, unknown> | null;
}) {
  const insertedValues: Array<Record<string, unknown>> = [];
  const db = {
    insertedValues,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          // listVersionsForPath: select(...).where(...).orderBy(...) → version list
          orderBy: vi.fn(async () => input.versions),
          // restore transaction: select(...).where(...).limit(1) → [current] or []
          limit: vi.fn(async () => (input.current ? [input.current] : [])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertedValues.push(value);
        return {
          onConflictDoUpdate: vi.fn(async () => undefined),
          // recordBrainFileVersion / enqueueWorkspaceSync return the builder and are awaited; the
          // version-record insert has no onConflictDoUpdate, so values() itself must be awaitable.
          then: (resolve: (value: unknown) => void) => resolve(undefined),
        };
      }),
    })),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  };
  return db;
}
