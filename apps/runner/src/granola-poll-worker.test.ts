import type { WorkflowEventTriggerRoute } from "@opencompany/db/workflow-event-routes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GranolaApiError, type GranolaNotesPage } from "./granola-api";
import {
  ingestGranolaNote,
  listGranolaNotesSince,
  pollGranolaIntegration,
} from "./granola-poll-worker";

const workerMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  fetchGranolaNote: vi.fn(),
  listClaimedWikiWorkspaceIds: vi.fn(),
  claimWikiEvents: vi.fn(),
  upsertWikiItem: vi.fn(),
  attributeWikiClaims: vi.fn(),
  captureQuotaAnalytics: vi.fn(),
  wakeWiki: vi.fn(),
  enqueueWorkflowEventRuns: vi.fn(),
  listWorkflowEventTriggerRoutes: vi.fn(),
  listGranolaFolders: vi.fn(),
  listGranolaNotes: vi.fn(),
  loadIntegrationCredential: vi.fn(),
  markIntegrationStatus: vi.fn(),
  ensureGranolaSyncState: vi.fn(),
  claimGranolaSyncState: vi.fn(),
  completeGranolaSyncPages: vi.fn(),
  updateGranolaSyncPage: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: workerMocks.getDb }));
vi.mock("./granola-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchGranolaNote: workerMocks.fetchGranolaNote,
  listGranolaNotes: workerMocks.listGranolaNotes,
}));
vi.mock("@opencompany/agent/integrations/granola", () => ({
  listGranolaFolders: workerMocks.listGranolaFolders,
}));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadIntegrationCredential: workerMocks.loadIntegrationCredential,
  markIntegrationStatus: workerMocks.markIntegrationStatus,
}));
vi.mock("@opencompany/db/granola", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureGranolaSyncState: workerMocks.ensureGranolaSyncState,
  claimGranolaSyncState: workerMocks.claimGranolaSyncState,
  completeGranolaSyncPages: workerMocks.completeGranolaSyncPages,
  updateGranolaSyncPage: workerMocks.updateGranolaSyncPage,
}));
vi.mock("@opencompany/analytics/product", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  captureProductIngestionQuotaAnalytics: workerMocks.captureQuotaAnalytics,
}));
vi.mock("@opencompany/db/workflow-event-routes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueWorkflowEventRuns: workerMocks.enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes: workerMocks.listWorkflowEventTriggerRoutes,
}));
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

describe("Granola meeting event routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tx = { sentinel: "tx" };
    workerMocks.getDb.mockReturnValue({
      transaction: vi.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
    });
    workerMocks.fetchGranolaNote.mockResolvedValue(granolaPayload());
    workerMocks.listClaimedWikiWorkspaceIds.mockResolvedValue(new Set<string>());
    workerMocks.claimWikiEvents.mockResolvedValue({
      claimedCount: 1,
      claimedEventKeys: ["note:note_1"],
    });
    workerMocks.upsertWikiItem.mockResolvedValue({
      sourceItemId: "gwsrc_1",
      jobId: "gwjob_1",
      enqueued: true,
      skipped: false,
    });
    workerMocks.attributeWikiClaims.mockResolvedValue(undefined);
    workerMocks.enqueueWorkflowEventRuns.mockResolvedValue(1);
  });

  it("enqueues one run keyed on the note id with the meeting as context", async () => {
    await expect(
      ingestMeeting({
        workflowRoutes: [meetingRoute()],
      }),
    ).resolves.toEqual({ workflowRuns: 1 });

    expect(workerMocks.fetchGranolaNote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ includeTranscript: false }),
    );

    expect(workerMocks.enqueueWorkflowEventRuns).toHaveBeenCalledWith(
      {
        routes: [expect.objectContaining({ workflowId: "workflow_1" })],
        deliveryId: "note:note_1",
        eventAt: new Date("2026-08-24T11:00:00.000Z"),
        context: {
          tag: "granola_meeting_context",
          lines: expect.arrayContaining([
            "Title: Roadmap review",
            "Attendees: Ada <ada@example.com>, Grace <grace@example.com>",
            "The team selected option A and committed to ship it in September.",
          ]),
        },
      },
      expect.anything(),
    );
  });

  it("fires a folder-filtered route for a note filed in one of that folder's subfolders", async () => {
    workerMocks.fetchGranolaNote.mockResolvedValue({
      ...granolaPayload(),
      folder_membership: [{ id: "fol_acme", name: "Acme", parent_folder_id: "fol_customers" }],
    });

    await expect(
      ingestMeeting({
        workflowRoutes: [meetingRoute({ folder: { id: "fol_customers" } })],
        folderParentIds: new Map([
          ["fol_acme", "fol_customers"],
          ["fol_customers", null],
        ]),
      }),
    ).resolves.toEqual({ workflowRuns: 1 });

    expect(workerMocks.enqueueWorkflowEventRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        routes: [expect.objectContaining({ workflowId: "workflow_1" })],
      }),
      expect.anything(),
    );
  });

  it("skips a folder-filtered route when the note is filed somewhere else", async () => {
    workerMocks.fetchGranolaNote.mockResolvedValue({
      ...granolaPayload(),
      folder_membership: [{ id: "fol_internal", name: "Internal", parent_folder_id: null }],
    });

    await expect(
      ingestMeeting({
        workflowRoutes: [meetingRoute({ folder: { id: "fol_customers" } })],
        folderParentIds: new Map([
          ["fol_internal", null],
          ["fol_customers", null],
        ]),
      }),
    ).resolves.toEqual({ workflowRuns: 0 });

    expect(workerMocks.enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });

  it("keeps an unfiltered route matching a note that belongs to no folder", async () => {
    await expect(ingestMeeting({ workflowRoutes: [meetingRoute()] })).resolves.toEqual({
      workflowRuns: 1,
    });
  });

  it("does not replay a stale backlog as one task per historical meeting", async () => {
    await expect(
      ingestMeeting({
        workflowRoutes: [meetingRoute()],
        now: new Date("2026-08-26T11:05:00.000Z"),
      }),
    ).resolves.toEqual({ workflowRuns: 0 });

    expect(workerMocks.fetchGranolaNote).toHaveBeenCalledOnce();
    expect(workerMocks.enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });
});

describe("Granola poll pass folder scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerMocks.getDb.mockReturnValue({ transaction: vi.fn() });
    workerMocks.ensureGranolaSyncState.mockResolvedValue(undefined);
    workerMocks.claimGranolaSyncState.mockResolvedValue({
      integrationId: "gint_granola_1",
      userWorkosId: "user_1",
      updatedAfterCursor: new Date("2026-08-24T10:00:00.000Z"),
      pageCursor: null,
      pendingUpdatedAfterCursor: null,
    });
    workerMocks.loadIntegrationCredential.mockResolvedValue({ payload: { apiKey: "grn_test" } });
    // The event skips a stale backlog, so a pass-level test needs a note that just finished.
    workerMocks.listGranolaNotes.mockResolvedValue({
      notes: [
        {
          id: "note_1",
          title: "Roadmap review",
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
          raw: {},
        },
      ],
      hasMore: false,
      cursor: null,
    });
    workerMocks.fetchGranolaNote.mockResolvedValue(granolaPayload());
    workerMocks.enqueueWorkflowEventRuns.mockResolvedValue(1);
    workerMocks.completeGranolaSyncPages.mockResolvedValue(true);
  });

  const poll = () =>
    pollGranolaIntegration({
      candidate: { integrationId: "gint_granola_1", userWorkosId: "user_1" },
      signal: new AbortController().signal,
    });

  it("does not read the folder tree when no route filters on one", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([meetingRoute()]);

    await expect(poll()).resolves.toEqual({ seen: 1, workflowRuns: 1 });
    expect(workerMocks.listGranolaFolders).not.toHaveBeenCalled();
  });

  it("asks for reconnection if the key is revoked while fetching the note", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([meetingRoute()]);
    workerMocks.fetchGranolaNote.mockRejectedValue(new GranolaApiError("Unauthorized", 401));

    await expect(poll()).resolves.toBeNull();
    expect(workerMocks.markIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "needs_reauth", integrationId: "gint_granola_1" }),
    );
    expect(workerMocks.completeGranolaSyncPages).not.toHaveBeenCalled();
    expect(workerMocks.updateGranolaSyncPage).not.toHaveBeenCalled();
  });

  it("routes other ready meetings after a note failure and retains the cursor for retry", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([meetingRoute()]);
    workerMocks.listGranolaNotes.mockResolvedValue({
      notes: ["note_failed", "note_1"].map((id) => ({
        id,
        title: id,
        updatedAt: new Date().toISOString(),
        raw: {},
      })),
      hasMore: false,
      cursor: null,
    });
    workerMocks.fetchGranolaNote
      .mockRejectedValueOnce(new GranolaApiError("Note unavailable", 404))
      .mockResolvedValueOnce(granolaPayload());

    await expect(poll()).rejects.toMatchObject({ status: 404 });
    expect(workerMocks.enqueueWorkflowEventRuns).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "note:note_1" }),
      expect.anything(),
    );
    expect(workerMocks.completeGranolaSyncPages).not.toHaveBeenCalled();
    expect(workerMocks.updateGranolaSyncPage).not.toHaveBeenCalled();
  });

  it("leaves the cursor alone when the folder tree a filter needs cannot be read", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([
      meetingRoute({ folder: { id: "fol_customers" } }),
    ]);
    workerMocks.listGranolaFolders.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      error: "Could not reach the Granola API. Try again in a moment.",
    });

    await expect(poll()).rejects.toThrow(/Could not read the Granola folder tree/);
    expect(workerMocks.completeGranolaSyncPages).not.toHaveBeenCalled();
    expect(workerMocks.updateGranolaSyncPage).not.toHaveBeenCalled();
    expect(workerMocks.enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });

  it("keeps polling an account with more folders than one listing reads", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([
      meetingRoute({ folder: { id: "fol_customers" } }),
    ]);
    workerMocks.listGranolaFolders.mockResolvedValue({
      ok: true,
      folders: [{ id: "fol_customers", name: "Customers", parentFolderId: null }],
      partial: true,
    });
    workerMocks.fetchGranolaNote.mockResolvedValue({
      ...granolaPayload(),
      folder_membership: [{ id: "fol_acme", parent_folder_id: "fol_customers" }],
    });

    // Retrying would never read more, and failing every pass would stop this connection's
    // ingestion for good, so the pass completes on the memberships it can still resolve.
    await expect(poll()).resolves.toEqual({ seen: 1, workflowRuns: 1 });
    expect(workerMocks.completeGranolaSyncPages).toHaveBeenCalled();
  });

  it("asks for a new API key when Granola rejects the folder read", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([
      meetingRoute({ folder: { id: "fol_customers" } }),
    ]);
    workerMocks.listGranolaFolders.mockResolvedValue({
      ok: false,
      reason: "unauthorized",
      error: "Granola rejected the saved API key.",
    });

    await expect(poll()).resolves.toBeNull();
    expect(workerMocks.markIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "needs_reauth" }),
    );
    expect(workerMocks.completeGranolaSyncPages).not.toHaveBeenCalled();
  });
});

const NOTE_UPDATED_AT = "2026-08-24T11:00:00.000Z";

function ingestMeeting(routes: {
  workflowRoutes?: WorkflowEventTriggerRoute[];
  folderParentIds?: ReadonlyMap<string, string | null>;
  now?: Date;
}) {
  return ingestGranolaNote({
    candidate: { integrationId: "gint_granola_1", userWorkosId: "user_1" },
    apiKey: "grn_test",
    note: {
      id: "note_1",
      title: "Roadmap review",
      updatedAt: NOTE_UPDATED_AT,
      raw: {},
    },
    now: new Date("2026-08-24T11:05:00.000Z"),
    ...routes,
    signal: new AbortController().signal,
  });
}

function meetingRoute(filters: Record<string, { id: string }> = {}) {
  return {
    workflowId: "workflow_1",
    workspaceId: "workspace_1",
    userWorkosId: "user_1",
    workflowSlug: "meeting-follow-ups",
    workflowName: "Meeting follow-ups",
    prompt: "Turn the decisions into Linear issues.",
    harnessSpec: {},
    provider: "granola",
    event: "meeting.notes_ready",
    filters,
  } as unknown as WorkflowEventTriggerRoute;
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
