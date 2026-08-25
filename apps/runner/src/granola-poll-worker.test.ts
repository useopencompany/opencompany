import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GranolaNotesPage } from "./granola-api";
import {
  ingestGranolaNote,
  listGranolaNotesSince,
  listGranolaPollCandidates,
} from "./granola-poll-worker";

const workerMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  fetchGranolaNote: vi.fn(),
  listClaimedBrainRefs: vi.fn(),
  listClaimedWikiWorkspaceIds: vi.fn(),
  claimBrainEvents: vi.fn(),
  claimWikiEvents: vi.fn(),
  upsertBrainItem: vi.fn(),
  upsertWikiItem: vi.fn(),
  attributeBrainClaims: vi.fn(),
  attributeWikiClaims: vi.fn(),
  captureQuotaAnalytics: vi.fn(),
  wakeBrain: vi.fn(),
  wakeWiki: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: workerMocks.getDb }));
vi.mock("./granola-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchGranolaNote: workerMocks.fetchGranolaNote,
}));
vi.mock("@opencompany/analytics/product", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  captureProductIngestionQuotaAnalytics: workerMocks.captureQuotaAnalytics,
}));
vi.mock("@opencompany/db/brain-event-claims", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attributeBrainSourceEventClaims: workerMocks.attributeBrainClaims,
  claimBrainSourceEvents: workerMocks.claimBrainEvents,
  listBrainSourceEventClaimedBrainRefs: workerMocks.listClaimedBrainRefs,
}));
vi.mock("@opencompany/db/brain-ingest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertBrainSourceItemAndEnqueue: workerMocks.upsertBrainItem,
}));
vi.mock("@opencompany/db/wiki-event-claims", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  attributeWikiSourceEventClaims: workerMocks.attributeWikiClaims,
  claimWikiSourceEvents: workerMocks.claimWikiEvents,
  listWikiSourceEventClaimedWorkspaceIds: workerMocks.listClaimedWikiWorkspaceIds,
}));
vi.mock("@opencompany/db/wiki-ingest", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertWikiSourceItemAndEnqueue: workerMocks.upsertWikiItem,
}));
vi.mock("./brain-ingest-worker", () => ({ wakeBrainIngestWorker: workerMocks.wakeBrain }));
vi.mock("./wiki-ingest-worker", () => ({ wakeWikiIngestWorker: workerMocks.wakeWiki }));

describe("Granola poll pagination", () => {
  it("returns a continuation cursor instead of advancing past unprocessed pages", async () => {
    const listNotes = vi.fn(async (input: { cursor?: string }): Promise<GranolaNotesPage> => {
      const page = input.cursor ? Number(input.cursor.slice(1)) : 0;
      return {
        notes: [
          {
            id: `note_${page}`,
            title: `Note ${page}`,
            updatedAt: `2026-07-16T10:0${page}:00.000Z`,
            raw: {},
          },
        ],
        hasMore: page < 5,
        cursor: page < 5 ? `c${page + 1}` : null,
      };
    });
    const signal = new AbortController().signal;

    const firstBatch = await listGranolaNotesSince({
      apiKey: "grn_test",
      updatedAfter: "2026-07-16T09:00:00.000Z",
      signal,
      listNotes,
    });
    expect(firstBatch.notes).toHaveLength(5);
    expect(firstBatch.nextCursor).toBe("c5");
    if (!firstBatch.nextCursor) throw new Error("Expected a Granola continuation cursor.");

    const finalBatch = await listGranolaNotesSince({
      apiKey: "grn_test",
      updatedAfter: "2026-07-16T09:00:00.000Z",
      cursor: firstBatch.nextCursor,
      signal,
      listNotes,
    });
    expect(finalBatch.notes.map((note) => note.id)).toEqual(["note_5"]);
    expect(finalBatch.nextCursor).toBeNull();
    expect(listNotes).toHaveBeenCalledTimes(6);
  });

  it("fails closed when Granola says more pages exist without advancing the cursor", async () => {
    await expect(
      listGranolaNotesSince({
        apiKey: "grn_test",
        updatedAfter: "2026-07-16T09:00:00.000Z",
        signal: new AbortController().signal,
        listNotes: async () => ({ notes: [], hasMore: true, cursor: null }),
      }),
    ).rejects.toThrow("did not return a new continuation cursor");
  });

  it("rejects a cursor cycle within a pagination batch", async () => {
    const cursors = ["c1", "c2", "c1"];
    let call = 0;
    await expect(
      listGranolaNotesSince({
        apiKey: "grn_test",
        updatedAfter: "2026-07-16T09:00:00.000Z",
        signal: new AbortController().signal,
        listNotes: async () => ({
          notes: [],
          hasMore: true,
          cursor: cursors[call++] ?? null,
        }),
      }),
    ).rejects.toThrow("did not return a new continuation cursor");
  });
});

describe("Granola wiki meeting routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tx = { sentinel: "tx" };
    workerMocks.getDb.mockReturnValue({
      transaction: vi.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
    });
    workerMocks.fetchGranolaNote.mockResolvedValue(granolaPayload());
    workerMocks.listClaimedBrainRefs.mockResolvedValue(new Set<string>());
    workerMocks.listClaimedWikiWorkspaceIds.mockResolvedValue(new Set<string>());
    workerMocks.claimBrainEvents.mockResolvedValue({
      claimedCount: 1,
      claimedEventKeys: ["note:note_1"],
    });
    workerMocks.claimWikiEvents.mockResolvedValue({
      claimedCount: 1,
      claimedEventKeys: ["note:note_1"],
    });
    workerMocks.upsertBrainItem.mockResolvedValue({
      sourceItemId: "gbsrc_1",
      jobId: "gbjob_1",
      jobIds: ["gbjob_1"],
      enqueued: true,
      skipped: false,
      quotaUpdates: undefined,
    });
    workerMocks.upsertWikiItem.mockResolvedValue({
      sourceItemId: "gwsrc_1",
      jobId: "gwjob_1",
      enqueued: true,
      skipped: false,
    });
    workerMocks.attributeBrainClaims.mockResolvedValue(undefined);
    workerMocks.attributeWikiClaims.mockResolvedValue(undefined);
  });

  it("unions enabled wiki sources into poll candidate selection", async () => {
    let query: SQL | undefined;
    const db = {
      execute: vi.fn(async (input: SQL) => {
        query = input;
        return { rows: [{ integrationId: "gint_1", userWorkosId: "user_1" }] };
      }),
    };

    await expect(listGranolaPollCandidates(db as never)).resolves.toEqual([
      { integrationId: "gint_1", userWorkosId: "user_1" },
    ]);

    const compiled = new PgDialect().sqlToQuery(query!);
    expect(compiled.sql).toContain("FROM goat.brain_sources bs");
    expect(compiled.sql).toContain("OR EXISTS");
    expect(compiled.sql).toContain("FROM goat.wiki_sources ws");
    expect(compiled.sql).toContain("ws.enabled = true");
  });

  it("does not fetch or enqueue when neither brain nor wiki has an enabled route", async () => {
    await expect(
      ingestMeeting({ routedBrainRefs: [], routedWikiWorkspaceIds: [] }),
    ).resolves.toEqual({ enqueued: false });

    expect(workerMocks.fetchGranolaNote).not.toHaveBeenCalled();
    expect(workerMocks.upsertBrainItem).not.toHaveBeenCalled();
    expect(workerMocks.upsertWikiItem).not.toHaveBeenCalled();
  });

  it("skips the transcript fetch when every routed wiki workspace already claimed the event", async () => {
    workerMocks.listClaimedWikiWorkspaceIds.mockResolvedValue(new Set(["workspace_1"]));

    await expect(
      ingestMeeting({
        routedBrainRefs: [],
        routedWikiWorkspaceIds: ["workspace_1"],
      }),
    ).resolves.toEqual({ enqueued: false });

    expect(workerMocks.fetchGranolaNote).not.toHaveBeenCalled();
    expect(workerMocks.claimWikiEvents).not.toHaveBeenCalled();
  });

  it("leaves the existing brain-only enqueue path untouched", async () => {
    await expect(
      ingestMeeting({
        routedBrainRefs: ["brain_1"],
        routedWikiWorkspaceIds: [],
      }),
    ).resolves.toEqual({ enqueued: true });

    expect(workerMocks.claimBrainEvents).toHaveBeenCalledWith(
      expect.objectContaining({ brainRef: "brain_1", eventKeys: ["note:note_1"] }),
    );
    expect(workerMocks.upsertBrainItem).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRefs: ["brain_1"],
        rawPayload: granolaPayload(),
        item: expect.objectContaining({
          sourceProvider: "granola",
          sourceType: "meeting",
          sourceRef: "granola:note:note_1",
        }),
      }),
    );
    expect(workerMocks.wakeBrain).toHaveBeenCalledOnce();
    expect(workerMocks.claimWikiEvents).not.toHaveBeenCalled();
    expect(workerMocks.upsertWikiItem).not.toHaveBeenCalled();
    expect(workerMocks.wakeWiki).not.toHaveBeenCalled();
  });

  it("claims and enqueues a wiki-only workspace with the normalized meeting payload", async () => {
    await expect(
      ingestMeeting({
        routedBrainRefs: [],
        routedWikiWorkspaceIds: ["workspace_1"],
      }),
    ).resolves.toEqual({ enqueued: true });

    expect(workerMocks.claimWikiEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        sourceProvider: "granola",
        eventKeys: ["note:note_1"],
      }),
    );
    expect(workerMocks.upsertWikiItem).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        sourceConnectionId: "gint_granola_1",
        integrationId: "gint_granola_1",
        rawPayload: granolaPayload(),
        item: expect.objectContaining({
          sourceProvider: "granola",
          sourceType: "meeting",
          sourceRef: "granola:note:note_1",
        }),
      }),
    );
    expect(workerMocks.attributeWikiClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        eventKeys: ["note:note_1"],
        sourceItemId: "gwsrc_1",
      }),
    );
    expect(workerMocks.wakeWiki).toHaveBeenCalledOnce();
    expect(workerMocks.upsertBrainItem).not.toHaveBeenCalled();
  });
});

function ingestMeeting(routes: { routedBrainRefs: string[]; routedWikiWorkspaceIds: string[] }) {
  return ingestGranolaNote({
    candidate: { integrationId: "gint_granola_1", userWorkosId: "user_1" },
    apiKey: "grn_test",
    note: {
      id: "note_1",
      title: "Roadmap review",
      updatedAt: "2026-08-24T11:00:00.000Z",
      raw: {},
    },
    ...routes,
    signal: new AbortController().signal,
  });
}

function granolaPayload() {
  return {
    id: "note_1",
    title: "Roadmap review",
    created_at: "2026-08-24T10:00:00.000Z",
    updated_at: "2026-08-24T11:00:00.000Z",
    summary_markdown: "The team selected option A and committed to ship it in September.",
    attendees: [
      { name: "Ada", email: "ada@example.com" },
      { name: "Grace", email: "grace@example.com" },
    ],
    transcript: [
      { speaker: { name: "Ada" }, text: "Option A is the durable choice." },
      { speaker: { name: "Grace" }, text: "I will own the September rollout." },
    ],
  };
}
