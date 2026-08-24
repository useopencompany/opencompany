import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  listBrainRoutes: vi.fn(),
  listWikiRoutes: vi.fn(),
  claimBrainEvents: vi.fn(),
  attributeBrainClaims: vi.fn(),
  upsertBrain: vi.fn(),
  claimWikiEvents: vi.fn(),
  attributeWikiClaims: vi.fn(),
  upsertWiki: vi.fn(),
  fetchSnapshot: vi.fn(),
  wakeBrain: vi.fn(),
  wakeWiki: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("@opencompany/db/gmail", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listEnabledGmailBrainSourceRoutes: mocks.listBrainRoutes,
  listEnabledGmailWikiSourceRoutes: mocks.listWikiRoutes,
}));
vi.mock("@opencompany/db/brain-event-claims", () => ({
  claimBrainSourceEvents: mocks.claimBrainEvents,
  attributeBrainSourceEventClaims: mocks.attributeBrainClaims,
}));
vi.mock("@opencompany/db/brain-ingest", () => ({
  BRAIN_AGENT_INGEST_JOB_KIND: "brain_agent_ingest",
  upsertBrainSourceItemAndEnqueue: mocks.upsertBrain,
}));
vi.mock("@opencompany/db/wiki-event-claims", () => ({
  claimWikiSourceEvents: mocks.claimWikiEvents,
  attributeWikiSourceEventClaims: mocks.attributeWikiClaims,
}));
vi.mock("@opencompany/db/wiki-ingest", () => ({
  upsertWikiSourceItemAndEnqueue: mocks.upsertWiki,
}));
vi.mock("./gmail-api", () => ({ fetchGmailThreadSnapshot: mocks.fetchSnapshot }));
vi.mock("./brain-ingest-worker", () => ({ wakeBrainIngestWorker: mocks.wakeBrain }));
vi.mock("./wiki-ingest-worker", () => ({ wakeWikiIngestWorker: mocks.wakeWiki }));

import { flushGmailThreadWindow, type GmailDueWindow } from "./gmail-flush-worker";

const window: GmailDueWindow = {
  integrationId: "integration_1",
  userWorkosId: "user_1",
  threadId: "thread_1",
};

const bufferedMessage = {
  id: "ggmevt_1",
  messageId: "message_1",
  rfc822MessageId: "<shared-message@example.com>",
  direction: "received",
  subject: "Acme renewal",
  fromHeader: "customer@acme.example",
  payload: { snippet: "We approve the renewal." },
  eventTime: "2026-08-24T10:00:00.000Z",
};

const env = {
  apiOrigin: "http://api.local",
  apiInternalToken: "token",
  instanceId: "runner_1",
  workerConcurrency: 1,
} as never;

describe("Gmail flush dual routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tx = {
      execute: vi.fn().mockResolvedValueOnce([bufferedMessage]).mockResolvedValueOnce([]),
    };
    mocks.getDb.mockReturnValue({
      execute: vi
        .fn()
        .mockResolvedValueOnce([bufferedMessage])
        .mockResolvedValueOnce([{ status: "connected", accountEmail: "ada@example.com" }]),
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
    });
    mocks.fetchSnapshot.mockResolvedValue(null);
    mocks.listBrainRoutes.mockResolvedValue([]);
    mocks.listWikiRoutes.mockResolvedValue([]);
    mocks.claimBrainEvents.mockResolvedValue({ claimedCount: 0, claimedEventKeys: [] });
    mocks.attributeBrainClaims.mockResolvedValue(undefined);
    mocks.upsertBrain.mockResolvedValue({
      sourceItemId: "gsrc_brain_1",
      enqueued: false,
      skipped: false,
    });
    mocks.claimWikiEvents.mockResolvedValue({
      claimedCount: 1,
      claimedEventKeys: ["shared-message@example.com"],
    });
    mocks.attributeWikiClaims.mockResolvedValue(undefined);
    mocks.upsertWiki.mockResolvedValue({
      sourceItemId: "gwsrc_1",
      jobId: "gwjob_1",
      enqueued: true,
      skipped: false,
    });
  });

  it("flushes a received-email window for a matching wiki-only route", async () => {
    mocks.listWikiRoutes.mockResolvedValue([
      {
        integrationId: "integration_1",
        workspaceId: "workspace_1",
        config: { events: [{ id: "email_received" }] },
      },
    ]);

    await expect(
      flushGmailThreadWindow(window, env, new AbortController().signal),
    ).resolves.toMatchObject({ eventCount: 1, enqueued: true });
    expect(mocks.upsertBrain).toHaveBeenCalledWith(expect.objectContaining({ brainRefs: [] }));
    expect(mocks.upsertWiki).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace_1", rawEventCount: 1 }),
    );
    expect(mocks.wakeWiki).toHaveBeenCalledOnce();
    expect(mocks.wakeBrain).not.toHaveBeenCalled();
  });

  it("does not claim or enqueue for a wiki route outside the selected event scope", async () => {
    mocks.listWikiRoutes.mockResolvedValue([
      {
        integrationId: "integration_1",
        workspaceId: "workspace_1",
        config: { events: [{ id: "email_sent" }] },
      },
    ]);

    await expect(
      flushGmailThreadWindow(window, env, new AbortController().signal),
    ).resolves.toMatchObject({ eventCount: 1, enqueued: false });
    expect(mocks.claimWikiEvents).not.toHaveBeenCalled();
    expect(mocks.upsertWiki).not.toHaveBeenCalled();
    expect(mocks.wakeWiki).not.toHaveBeenCalled();
  });
});
