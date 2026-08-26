import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  loadCredential: vi.fn(),
  listBrainRoutes: vi.fn(),
  listWikiRoutes: vi.fn(),
  claimBrainEvents: vi.fn(),
  attributeBrainClaims: vi.fn(),
  upsertBrain: vi.fn(),
  claimWikiEvents: vi.fn(),
  attributeWikiClaims: vi.fn(),
  upsertWiki: vi.fn(),
  wakeBrain: vi.fn(),
  wakeWiki: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("@opencompany/db/integrations", () => ({
  loadIntegrationCredential: mocks.loadCredential,
}));
vi.mock("@opencompany/db/slack", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listEnabledSlackBrainSourceRoutes: mocks.listBrainRoutes,
  listEnabledSlackWikiSourceRoutes: mocks.listWikiRoutes,
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
vi.mock("./brain-ingest-worker", () => ({ wakeBrainIngestWorker: mocks.wakeBrain }));
vi.mock("./wiki-ingest-worker", () => ({ wakeWikiIngestWorker: mocks.wakeWiki }));

import { flushSlackConversationWindow, type SlackDueWindow } from "./slack-flush-worker";

const window: SlackDueWindow = {
  integrationId: "integration_1",
  userWorkosId: "user_1",
  teamId: "T123",
  channelId: "C123",
  channelType: "channel",
};

const bufferedMessage = {
  id: "gslkmsg_1",
  messageTs: "1724493600.000100",
  threadTs: null,
  slackUserId: "U123",
  subtype: null,
  text: "Acme approved the onboarding plan.",
  payload: {},
};

describe("Slack flush dual routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tx = {
      execute: vi.fn().mockResolvedValueOnce([bufferedMessage]).mockResolvedValueOnce([]),
    };
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([bufferedMessage])
        .mockResolvedValueOnce([{ status: "connected" }]),
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
    };
    mocks.getDb.mockReturnValue(db);
    mocks.loadCredential.mockResolvedValue(null);
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
      claimedEventKeys: ["T123:C123:1724493600.000100"],
    });
    mocks.attributeWikiClaims.mockResolvedValue(undefined);
    mocks.upsertWiki.mockResolvedValue({
      sourceItemId: "gwsrc_1",
      jobId: "gwjob_1",
      enqueued: true,
      skipped: false,
    });
  });

  it("flushes and wakes the wiki worker with no brain routes", async () => {
    mocks.listWikiRoutes.mockResolvedValue([
      {
        integrationId: "integration_1",
        workspaceId: "workspace_1",
        config: { channels: [{ id: "C123", name: "product" }] },
      },
    ]);

    await expect(flushSlackConversationWindow(window)).resolves.toEqual({
      sourceItemId: "gsrc_brain_1",
      messageCount: 1,
      enqueued: true,
    });

    expect(mocks.upsertBrain).toHaveBeenCalledWith(
      expect.objectContaining({ brainRefs: [], rawEventCount: 1 }),
    );
    expect(mocks.claimWikiEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        sourceProvider: "slack",
        eventKeys: ["T123:C123:1724493600.000100"],
      }),
    );
    expect(mocks.upsertWiki).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        integrationId: "integration_1",
        rawEventCount: 1,
      }),
    );
    expect(mocks.wakeWiki).toHaveBeenCalledOnce();
    expect(mocks.wakeBrain).not.toHaveBeenCalled();
  });

  it("leaves the existing brain-only enqueue behavior intact", async () => {
    mocks.listBrainRoutes.mockResolvedValue([
      {
        integrationId: "integration_1",
        brainRef: "brain_1",
        config: { channels: [{ id: "C123", name: "product" }] },
      },
    ]);
    mocks.claimBrainEvents.mockResolvedValue({
      claimedCount: 1,
      claimedEventKeys: ["T123:C123:1724493600.000100"],
    });
    mocks.upsertBrain.mockResolvedValue({
      sourceItemId: "gsrc_brain_1",
      enqueued: true,
      skipped: false,
    });

    await expect(flushSlackConversationWindow(window)).resolves.toEqual({
      sourceItemId: "gsrc_brain_1",
      messageCount: 1,
      enqueued: true,
    });

    expect(mocks.upsertBrain).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        sourceConnectionId: "integration_1",
        integrationId: "integration_1",
        rawPayload: { eventIds: ["gslkmsg_1"] },
        rawEventCount: 1,
        brainRefs: ["brain_1"],
      }),
    );
    expect(mocks.upsertWiki).not.toHaveBeenCalled();
    expect(mocks.wakeBrain).toHaveBeenCalledOnce();
    expect(mocks.wakeWiki).not.toHaveBeenCalled();
  });

  it("does not enqueue a second wiki job when every event claim is already held", async () => {
    mocks.listWikiRoutes.mockResolvedValue([
      {
        integrationId: "integration_1",
        workspaceId: "workspace_1",
        config: { channels: [{ id: "C123", name: "product" }] },
      },
    ]);
    mocks.claimWikiEvents.mockResolvedValue({ claimedCount: 0, claimedEventKeys: [] });

    await expect(flushSlackConversationWindow(window)).resolves.toMatchObject({
      enqueued: false,
    });

    expect(mocks.claimWikiEvents).toHaveBeenCalledOnce();
    expect(mocks.upsertWiki).not.toHaveBeenCalled();
    expect(mocks.attributeWikiClaims).not.toHaveBeenCalled();
    expect(mocks.wakeWiki).not.toHaveBeenCalled();
  });
});
