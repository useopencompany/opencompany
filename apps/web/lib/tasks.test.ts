import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { createGoatTaskForUser } from "@/lib/tasks";

const mocks = vi.hoisted(() => ({
  after: vi.fn((work: Promise<unknown> | (() => unknown)) =>
    typeof work === "function" ? work() : work,
  ),
  captureGoatTaskSpawned: vi.fn(async () => undefined),
  execute: vi.fn(),
  select: vi.fn(),
  triggerGoatCodexChatWake: vi.fn(),
}));

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatTaskSpawned: mocks.captureGoatTaskSpawned,
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({ execute: mocks.execute, select: mocks.select }),
}));

vi.mock("@/lib/task-runner", () => ({
  triggerGoatCodexChatWake: mocks.triggerGoatCodexChatWake,
}));

vi.mock("@opencompany/goat-agent/integrations/google-data", () => ({
  getGoatAvailableHarnessTools: vi.fn(async () => ["exa_search", "gmail_search"]),
}));

vi.mock("next/server", () => ({ after: mocks.after }));

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.select.mockReset();
  mocks.triggerGoatCodexChatWake.mockReset().mockResolvedValue(undefined);
});

describe("createGoatTaskForUser", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCanonicalTaskCreation();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => warnSpy.mockRestore());

  it("creates the canonical conversation and leaves its Run queued when dispatch fails", async () => {
    mocks.triggerGoatCodexChatWake.mockRejectedValue(new Error("runner unavailable"));

    const task = await createGoatTaskForUser({
      userWorkosId: "user_1",
      prompt: "Research x",
      model: DEFAULT_GOAT_MODEL,
    });

    expect(task).toMatchObject({
      id: "task_1",
      sessionId: "conversation_1",
      status: "queued",
      stage: "queued",
    });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(sqlTextFromExecuteCall(1)).toContain("INSERT INTO goat.chat_messages");
    expect(sqlTextFromExecuteCall(1)).toContain("INSERT INTO goat.codex_chat_turns");
    expect(sqlTextFromExecuteCall(1)).toContain("'run.queued'");
    expect(sqlTextFromExecuteCall(1)).not.toContain("goat.task_messages");
    expect(mocks.triggerGoatCodexChatWake).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      "Goat durable task wake failed; the turn remains queued for polling.",
      expect.objectContaining({ event: "goat.durable_task_created_wake_failed" }),
    );
  });

  it("records the same source metadata for internal web producers", async () => {
    mockCanonicalTaskCreation({ source: "workflow", workflowId: "workflow_1" });
    await createGoatTaskForUser({
      userWorkosId: "user_1",
      prompt: "Research x",
      model: DEFAULT_GOAT_MODEL,
      workflowId: "workflow_1",
      source: "workflow",
      idempotencyKey: "workflow:workflow_1:run:1",
    });

    expect(mocks.captureGoatTaskSpawned).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task_1",
        workspaceId: "workspace_1",
        workflowId: "workflow_1",
        trigger: "manual",
      }),
    );
  });

  it("does not create or dispatch when Tasks & Workflows is disabled", async () => {
    mockSelectRows([{ workspaceId: "workspace_1" }]);
    mocks.execute
      .mockReset()
      .mockResolvedValueOnce([{ authorized: true, featureEnabled: false, commandId: null }]);

    await expect(
      createGoatTaskForUser({
        userWorkosId: "user_1",
        prompt: "Research x",
        model: DEFAULT_GOAT_MODEL,
      }),
    ).rejects.toThrow("Tasks & Workflows is disabled");

    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.captureGoatTaskSpawned).not.toHaveBeenCalled();
    expect(mocks.triggerGoatCodexChatWake).not.toHaveBeenCalled();
  });

  it("reports an actor without workspace membership", async () => {
    mockSelectRows([]);

    await expect(
      createGoatTaskForUser({
        userWorkosId: "missing_user",
        prompt: "Research x",
        model: DEFAULT_GOAT_MODEL,
      }),
    ).rejects.toThrow("workspace membership");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

function mockSelectRows(...rowSets: unknown[][]) {
  const pending = [...rowSets];
  mocks.select.mockReset().mockImplementation(() => {
    const rows = pending.shift() ?? [];
    const chain = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(async () => rows),
    };
    return chain;
  });
}

function mockCanonicalTaskCreation(
  overrides: { source?: "manual" | "workflow"; workflowId?: string | null } = {},
) {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const source = overrides.source ?? "manual";
  const workflowId = overrides.workflowId ?? null;
  const physicalTask = {
    id: "task_1",
    displayId: "TASK-1",
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    name: "Research x",
    prompt: "Research x",
    source,
    model: DEFAULT_GOAT_MODEL,
    sessionId: "conversation_1",
    scheduleId: null,
    scheduledFor: null,
    status: "queued" as const,
    stage: "queued" as const,
    result: null,
    error: null,
    workflowId,
    workflowBrainRef: null,
    reportedOutcome: null,
    outcomeComment: null,
    harnessSpec: {
      schemaVersion: "goat.harness.v1" as const,
      engine: "opencompany" as const,
      model: DEFAULT_GOAT_MODEL,
      systemPrompt: "",
      initialUserMessage: "Research x",
      tools: ["exa_search", "gmail_search"],
      skills: [],
      maxModelSteps: 16,
      resultMode: "assistant_final" as const,
    },
    debugTrace: {},
    codexEngineSessionId: null,
    sandboxId: null,
    attempts: 0,
    nextRunAt: createdAt,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  mockSelectRows([{ workspaceId: "workspace_1" }], [physicalTask]);
  mocks.execute
    .mockReset()
    .mockResolvedValueOnce([{ authorized: true, featureEnabled: true, commandId: null }])
    .mockImplementationOnce(async (query: SQL) => ({
      rows: [
        {
          authorized: true,
          featureEnabled: true,
          commandId: "task_command_1",
          requestHash: requestHashFromQuery(query),
          taskId: "task_1",
          reservedConversationId: "conversation_1",
          messageId: "message_1",
          assistantMessageId: "message_2",
          runId: "run_1",
          transactionId: "1",
          replayed: false,
          materialized: true,
          id: "task_1",
          displayId: "TASK-1",
          name: "Research x",
          goal: "Research x",
          taskConversationId: "conversation_1",
          status: "queued",
          source,
          engine: "opencompany",
          model: DEFAULT_GOAT_MODEL,
          workflowId,
          scheduleId: null,
          scheduledFor: null,
          result: null,
          error: null,
          reportedStatus: null,
          outcomeComment: null,
          archivedAt: null,
          createdAt,
          updatedAt: createdAt,
        },
      ],
    }));
}

function requestHashFromQuery(query: SQL) {
  const requestHash = new PgDialect()
    .sqlToQuery(query)
    .params.find(
      (value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
    );
  if (!requestHash) throw new Error("Expected a canonical request hash.");
  return requestHash;
}

function sqlTextFromExecuteCall(callIndex: number) {
  const query = mocks.execute.mock.calls[callIndex]?.[0] as SQL | undefined;
  expect(query).toBeDefined();
  return new PgDialect().sqlToQuery(query!).sql;
}
