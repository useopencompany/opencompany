import type { WorkflowEventTriggerRoute } from "@opencompany/db/workflow-event-routes";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workerMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  ensureSyncState: vi.fn(),
  claimSyncState: vi.fn(),
  updateSyncCursor: vi.fn(),
  insertMessageEvents: vi.fn(),
  listBrainRoutes: vi.fn(),
  listWorkflowEventTriggerRoutes: vi.fn(),
  enqueueWorkflowEventRuns: vi.fn(),
  fetchProfile: vi.fn(),
  listHistory: vi.fn(),
  fetchMetadata: vi.fn(),
  fetchBodyText: vi.fn(),
  googleApiCall: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: workerMocks.getDb }));
vi.mock("@opencompany/db/gmail", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureGmailSyncState: workerMocks.ensureSyncState,
  claimGmailSyncState: workerMocks.claimSyncState,
  updateGmailSyncCursor: workerMocks.updateSyncCursor,
  insertGmailMessageEvents: workerMocks.insertMessageEvents,
  listEnabledGmailBrainSourceRoutes: workerMocks.listBrainRoutes,
}));
vi.mock("@opencompany/db/workflow-event-routes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkflowEventTriggerRoutes: workerMocks.listWorkflowEventTriggerRoutes,
  enqueueWorkflowEventRuns: workerMocks.enqueueWorkflowEventRuns,
}));
vi.mock("./gmail-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchGmailProfile: workerMocks.fetchProfile,
  listGmailHistoryMessagesAdded: workerMocks.listHistory,
  fetchGmailMessageMetadata: workerMocks.fetchMetadata,
  fetchGmailMessageBodyText: workerMocks.fetchBodyText,
}));
vi.mock("./google-api-auth", () => ({ googleApiCall: workerMocks.googleApiCall }));

import { listGmailPollCandidates, pollGmailIntegration } from "./gmail-poll-worker";

const candidate = {
  integrationId: "integration_1",
  userWorkosId: "user_1",
  accountEmail: "founder@startup.com",
};

const now = new Date("2026-09-16T12:00:00.000Z");

function route(overrides: Partial<WorkflowEventTriggerRoute> = {}): WorkflowEventTriggerRoute {
  return {
    workflowId: "workflow_1",
    triggerId: "trigger_1",
    workspaceId: "workspace_1",
    userWorkosId: "user_1",
    workflowSlug: "triage-inbound",
    workflowName: "Triage inbound",
    prompt: "Triage this email.",
    harnessSpec: {} as WorkflowEventTriggerRoute["harnessSpec"],
    provider: "gmail",
    event: "email.received",
    filters: {},
    ...overrides,
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    threadId: "thread_1",
    labelIds: ["INBOX", "UNREAD"],
    subject: "Renewal question",
    from: "dana@acme.com",
    to: "founder@startup.com",
    cc: null,
    rfc822MessageId: "<abc@acme.com>",
    snippet: "Can we move to annual",
    internalDate: new Date("2026-09-16T11:59:00.000Z"),
    ...overrides,
  };
}

const env = { googleOAuthClientId: "id", googleOAuthClientSecret: "secret" } as never;

async function poll() {
  return pollGmailIntegration({
    candidate,
    env,
    signal: new AbortController().signal,
    now,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  workerMocks.getDb.mockReturnValue({});
  workerMocks.claimSyncState.mockResolvedValue({
    integrationId: candidate.integrationId,
    userWorkosId: candidate.userWorkosId,
    emailAddress: candidate.accountEmail,
    historyId: "100",
  });
  workerMocks.listBrainRoutes.mockResolvedValue([]);
  workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([]);
  workerMocks.enqueueWorkflowEventRuns.mockResolvedValue(1);
  workerMocks.insertMessageEvents.mockResolvedValue(0);
  workerMocks.fetchBodyText.mockResolvedValue("Can we move to annual billing?");
  workerMocks.listHistory.mockResolvedValue({
    messages: [{ id: "msg_1", threadId: "thread_1", labelIds: ["INBOX"] }],
    latestHistoryId: "200",
    expired: false,
  });
  workerMocks.fetchMetadata.mockResolvedValue(metadata());
});

describe("Gmail polling routes", () => {
  it("polls Brain targets without retired Wiki sources", async () => {
    let query: SQL | undefined;
    const db = {
      execute: vi.fn(async (value: SQL) => {
        query = value;
        return [];
      }),
    };

    await expect(listGmailPollCandidates(db as never)).resolves.toEqual([]);

    const compiled = new PgDialect().sqlToQuery(query!);
    expect(compiled.sql).toContain("FROM goat.brain_sources bs");
    expect(compiled.sql).not.toContain("goat.wiki_sources");
    expect(compiled.sql).toContain("bs.enabled = true");
  });

  it("also polls an account whose only consumer is an active event trigger", async () => {
    let query: SQL | undefined;
    const db = {
      execute: vi.fn(async (value: SQL) => {
        query = value;
        return [];
      }),
    };

    await listGmailPollCandidates(db as never);

    const compiled = new PgDialect().sqlToQuery(query!);
    expect(compiled.sql).toContain("FROM goat.workflows w");
    expect(compiled.sql).toContain("p.event_modes->'email.received' = 'true'::jsonb");
    expect(compiled.sql).toContain("w.status = 'active'");
    expect(compiled.sql).toContain("goat.workspace_members member");
    // Event triggers bind to personal connections only.
    expect(compiled.sql).toContain("i.workspace_id IS NULL");
  });
});

describe("Gmail workflow event routing", () => {
  it("starts one run per matching route and carries the body into the goal context", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([route()]);

    await expect(poll()).resolves.toEqual({ buffered: 0, workflowRuns: 1 });

    const enqueued = workerMocks.enqueueWorkflowEventRuns.mock.calls[0]![0];
    expect(enqueued.deliveryId).toBe("message:integration_1:msg_1");
    expect(enqueued.eventAt).toEqual(new Date("2026-09-16T11:59:00.000Z"));
    expect(enqueued.context.tag).toBe("gmail_email_context");
    expect(enqueued.context.lines.join("\n")).toContain("Can we move to annual billing?");
  });

  it("ignores a route bound to a different Gmail event", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([route({ event: "email.sent" })]);

    await expect(poll()).resolves.toEqual({ buffered: 0, workflowRuns: 0 });
    expect(workerMocks.enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });

  it("never fires on mail this mailbox sent, so an emailing workflow cannot retrigger itself", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([route()]);
    workerMocks.fetchMetadata.mockResolvedValue(metadata({ labelIds: ["SENT", "INBOX"] }));

    await expect(poll()).resolves.toEqual({ buffered: 0, workflowRuns: 0 });
    expect(workerMocks.enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });

  it("only routes a message that carries the filtered label", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([
      route({ filters: { label: { id: "Label_2" } } }),
    ]);

    await expect(poll()).resolves.toEqual({ buffered: 0, workflowRuns: 0 });

    workerMocks.fetchMetadata.mockResolvedValue(
      metadata({ labelIds: ["INBOX", "Label_2", "UNREAD"] }),
    );
    await expect(poll()).resolves.toEqual({ buffered: 0, workflowRuns: 1 });
  });

  it("does not replay a backlog older than a day", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([route()]);
    workerMocks.fetchMetadata.mockResolvedValue(
      metadata({ internalDate: new Date("2026-09-14T12:00:00.000Z") }),
    );

    await expect(poll()).resolves.toEqual({ buffered: 0, workflowRuns: 0 });
    expect(workerMocks.enqueueWorkflowEventRuns).not.toHaveBeenCalled();
  });

  it("caps how many messages in one pass may start a run", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([route()]);
    workerMocks.listHistory.mockResolvedValue({
      messages: Array.from({ length: 30 }, (_value, index) => ({
        id: `msg_${index}`,
        threadId: "thread_1",
        labelIds: ["INBOX"],
      })),
      latestHistoryId: "200",
      expired: false,
    });
    workerMocks.fetchMetadata.mockImplementation(async (_call: unknown, messageId: string) =>
      metadata({ id: messageId }),
    );

    await expect(poll()).resolves.toEqual({ buffered: 0, workflowRuns: 25 });
    expect(workerMocks.enqueueWorkflowEventRuns).toHaveBeenCalledTimes(25);
    // The cursor still advances, because ingestion shares it.
    expect(workerMocks.updateSyncCursor).toHaveBeenCalledWith(
      expect.objectContaining({ historyId: "200" }),
      expect.anything(),
    );
  });

  it("authorizes neither consumer on a pass that found no new mail", async () => {
    workerMocks.listHistory.mockResolvedValue({
      messages: [],
      latestHistoryId: "200",
      expired: false,
    });

    await expect(poll()).resolves.toEqual({ buffered: 0, workflowRuns: 0 });

    expect(workerMocks.listWorkflowEventTriggerRoutes).not.toHaveBeenCalled();
    expect(workerMocks.listBrainRoutes).not.toHaveBeenCalled();
    // The cursor still advances past the empty window.
    expect(workerMocks.updateSyncCursor).toHaveBeenCalledWith(
      expect.objectContaining({ historyId: "200" }),
      expect.anything(),
    );
  });

  it("reads the full message only for a message a route matched", async () => {
    await poll();
    expect(workerMocks.fetchBodyText).not.toHaveBeenCalled();

    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([route()]);
    await poll();
    expect(workerMocks.fetchBodyText).toHaveBeenCalledTimes(1);
  });

  it("starts the workflow on the snippet when the body cannot be read", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([route()]);
    workerMocks.fetchBodyText.mockResolvedValue(null);

    await expect(poll()).resolves.toEqual({ buffered: 0, workflowRuns: 1 });
    const enqueued = workerMocks.enqueueWorkflowEventRuns.mock.calls[0]![0];
    expect(enqueued.context.lines.join("\n")).toContain("Can we move to annual");
  });
});

describe("Gmail ingestion buffering", () => {
  it("buffers nothing for an event-only account with no enabled brain source", async () => {
    workerMocks.listWorkflowEventTriggerRoutes.mockResolvedValue([route()]);

    await poll();

    expect(workerMocks.insertMessageEvents).toHaveBeenCalledWith([], expect.anything());
  });

  it("still buffers for ingestion when a brain source is enabled", async () => {
    workerMocks.listBrainRoutes.mockResolvedValue([
      { integrationId: candidate.integrationId, brainRef: "brain_1", config: {} },
    ]);
    workerMocks.insertMessageEvents.mockResolvedValue(1);

    await expect(poll()).resolves.toEqual({ buffered: 1, workflowRuns: 0 });
    const inserts = workerMocks.insertMessageEvents.mock.calls[0]![0];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ messageId: "msg_1", direction: "received" });
  });
});
