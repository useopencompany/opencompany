import { ACTION_HOST_TOOL_CONTRACT_VERSION } from "@opencompany/agent-runtime";
import type { CodexChatTurn, HarnessSpec, Task } from "@opencompany/db/product-schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskTurnTerminalError } from "./codex-chat-errors";
import {
  buildTaskTurnCompletion,
  markTaskTurnRunning,
  settleDurableTurn,
  type TaskTurnContext,
} from "./task-turn";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));
const analyticsMocks = vi.hoisted(() => ({
  captureProductLlmUsageRecorded: vi.fn(async () => undefined),
  captureProductModelSpendRecorded: vi.fn(async () => undefined),
  captureProductServerEvent: vi.fn(async () => undefined),
}));
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductLlmUsageRecorded: analyticsMocks.captureProductLlmUsageRecorded,
  captureProductModelSpendRecorded: analyticsMocks.captureProductModelSpendRecorded,
  captureProductServerEvent: analyticsMocks.captureProductServerEvent,
  productAnalyticsUsageSourceForEngine: (engine: "opencompany" | "codex" | "claude_code") =>
    engine === "opencompany" ? "owned_platform" : "external_harness",
}));

vi.mock("@opencompany/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opencompany/observability")>()),
  createLogger: () => loggerMocks,
}));

describe("session-backed task turns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ rows: [{ id: "runtime_1" }] });
  });

  it("turns a completed workflow step into the next engine-specific durable turn", () => {
    const spec = workflowSpec();
    spec.codex = { repository: "octo/repo", reasoningEffort: "low" };
    spec.workflow!.steps![1] = {
      ...spec.workflow!.steps![1]!,
      reasoningEffort: "xhigh",
    };
    const completion = buildTaskTurnCompletion({
      context: context(spec),
      result: "Repository audit complete.",
      reportedOutcome: "done",
      outcomeComment: "The repository is ready.",
    });

    expect(completion.harnessSpec).toMatchObject({
      engine: "codex",
      model: "openai/gpt-5.5",
      codex: {
        repository: "octo/repo",
        reasoningEffort: "xhigh",
      },
      workflow: {
        currentStepIndex: 1,
        completedStepCount: 1,
        lastCompletedStepOutcome: {
          reportedOutcome: "done",
          outcomeComment: "The repository is ready.",
        },
      },
    });
    expect(completion.nextTurn).toMatchObject({
      engine: "codex",
      chatModel: "openai/gpt-5.5",
      settings: { reasoningEffort: "xhigh" },
      prompt: expect.stringContaining("Step 2/2 — Implement"),
    });
    expect(completion.nextTurn?.prompt).toContain("Repository audit complete.");
  });

  it("passes the previous step result as an explicit handoff to opencompany steps", () => {
    const spec = workflowSpec();
    spec.codex = { repository: "octo/repo", reasoningEffort: "low" };
    const nextStep = spec.workflow?.steps?.[1];
    if (!nextStep) throw new Error("Expected workflow fixture to have a second step.");
    nextStep.engine = "opencompany";
    nextStep.model = "moonshotai/kimi-k2.6";

    const completion = buildTaskTurnCompletion({
      context: context(spec),
      result: "Repository audit complete.",
      reportedOutcome: "done",
      outcomeComment: "The repository is ready.",
    });

    expect(completion.nextTurn).toMatchObject({
      engine: "opencompany",
      prompt: expect.stringContaining("Step 2/2 — Implement"),
    });
    expect(completion.harnessSpec.codex).toBeUndefined();
    expect(completion.nextTurn?.settings).toEqual({});
    expect(completion.nextTurn?.prompt).toContain("<previous_step_result>");
    expect(completion.nextTurn?.prompt).toContain("Repository audit complete.");
  });

  it("turns a completed workflow step into a Claude Code durable turn", () => {
    const spec = workflowSpec();
    spec.workflow!.steps![1] = {
      ...spec.workflow!.steps![1]!,
      engine: "claude_code",
      model: "anthropic/claude-sonnet-5",
      reasoningEffort: "medium",
    };
    const completion = buildTaskTurnCompletion({
      context: context(spec),
      result: "Repository audit complete.",
      reportedOutcome: "done",
      outcomeComment: "The repository is ready.",
    });

    expect(completion.nextTurn).toMatchObject({
      engine: "claude_code",
      chatModel: "anthropic/claude-sonnet-5",
      runtimeModel: "claude-sonnet-5",
      hostToolContractVersion: ACTION_HOST_TOOL_CONTRACT_VERSION,
      settings: { reasoningEffort: "medium" },
      prompt: expect.stringContaining("Step 2/2 — Implement"),
    });
    expect(completion.nextTurn?.prompt).toContain("<previous_step_result>");
    expect(completion.nextTurn?.prompt).toContain("Repository audit complete.");
  });

  it("halts a workflow on needs_attention and labels the blocking step", () => {
    const completion = buildTaskTurnCompletion({
      context: context(workflowSpec()),
      result: "Credentials are missing.",
      reportedOutcome: "needs_attention",
      outcomeComment: "Connect GitHub.",
    });

    expect(completion.nextTurn).toBeNull();
    expect(completion.outcomeComment).toBe("Step 1 (Audit): Connect GitHub.");
    expect(completion.harnessSpec.workflow).toMatchObject({
      currentStepIndex: 0,
      completedStepCount: 1,
    });
  });

  it("continues a successful workflow turn when no outcome was reported", () => {
    const completion = buildTaskTurnCompletion({
      context: context(workflowSpec()),
      result: "Repository audit complete.",
    });

    expect(completion.reportedOutcome).toBeNull();
    expect(completion.nextTurn).toMatchObject({
      engine: "codex",
      prompt: expect.stringContaining("Step 2/2 — Implement"),
    });
  });

  it("queues a scheduled task check-in instead of finalizing the task", async () => {
    const now = new Date("2026-07-30T09:30:00.000Z");
    const spec = workflowSpec();
    spec.engine = "claude_code";
    spec.model = "anthropic/claude-sonnet-5";
    spec.workflow!.steps![0] = {
      ...spec.workflow!.steps![0]!,
      engine: "claude_code",
      model: "anthropic/claude-sonnet-5",
    };
    const completion = buildTaskTurnCompletion({
      context: context(spec),
      result: "PR opened; CI is still running.",
      reportedOutcome: "needs_attention",
      outcomeComment: "Waiting for CI.",
      scheduledWakeup: {
        wakeup: {
          delaySeconds: 600,
          reason: "Wait for CI",
          prompt: "Inspect PR #42.",
        },
        parentSettings: {
          reasoningEffort: "high",
          scheduledWakeup: {
            delaySeconds: 600,
            reason: "Wait for CI",
            prompt: "Inspect PR #42.",
          },
        },
        now,
      },
    });

    expect(completion.nextTurn).toMatchObject({
      engine: "claude_code",
      userMessageContent: "Scheduled check-in: Wait for CI",
      userMessageDebugTrace: {
        scheduledWakeup: {
          reason: "Wait for CI",
          dueAt: "2026-07-30T09:40:00.000Z",
        },
      },
      runAfter: new Date("2026-07-30T09:40:00.000Z"),
      settings: { reasoningEffort: "high", wakeupChain: 1 },
      prompt: expect.stringContaining("Inspect PR #42."),
    });
    expect(completion.nextTurn?.prompt).toContain("Automated scheduled wakeup");
    expect(completion.nextTurn?.settings).not.toHaveProperty("scheduledWakeup");

    await settleDurableTurn({
      target: {
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        codexChatSessionId: "runtime_1",
        chatSessionId: "goat_chat_task_1",
        turnId: "turn_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
      },
      turnStatus: "completed",
      sessionStatus: "idle",
      error: null,
      completedAt: now,
      taskCompletion: completion,
    });

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("run_after");
    expect(query.sql).toContain("debug_trace");
    expect(query.params).toContain("Scheduled check-in: Wait for CI");
    expect(query.params).toContainEqual(new Date("2026-07-30T09:40:00.000Z"));
    expect(query.params).toContain('{"reasoningEffort":"high","wakeupChain":1}');
  });

  it("classifies an already-terminal task as an interrupt while the turn lease is held", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ outcome: "terminal" }] });

    await expect(
      markTaskTurnRunning({
        context: context(workflowSpec()),
        turn: durableTurn(),
      }),
    ).rejects.toBeInstanceOf(TaskTurnTerminalError);

    const statement = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]?.[0]).sql;
    expect(statement).toContain("task.status IN ('succeeded', 'failed', 'canceled')");
    expect(statement).toContain("EXISTS (");
  });

  it("settles the canonical Attempt and terminal event log in the fenced turn statement", async () => {
    await settleDurableTurn({
      target: {
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        codexChatSessionId: "runtime_1",
        chatSessionId: "goat_chat_1",
        turnId: "turn_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
      },
      turnStatus: "completed",
      sessionStatus: "idle",
      error: null,
      completedAt: new Date("2026-07-30T09:30:00.000Z"),
      canonicalRun: {
        attemptId: "attempt_1",
        assistantMessageId: "assistant_message_1",
        content: "Finished response",
      },
    });

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("finished_canonical_attempt AS");
    expect(query.sql).toContain("inserted_canonical_events AS");
    expect(query.sql).toContain("canonical_settlement_guard AS MATERIALIZED");
    expect(query.sql).toContain("has_unseen = CASE");
    expect(query.sql).toContain("event_sequence = turn.event_sequence +");
    expect(query.sql).toContain("pg_notify");
    expect(query.params).toContain("attempt_1");
    expect(query.params).toContainEqual(
      expect.stringContaining('"type":"message.content_updated"'),
    );
    expect(query.params).toContainEqual(expect.stringContaining('"type":"run.completed"'));
    expect(canonicalEventTypes(query.params)).toEqual(["message.content_updated", "run.completed"]);
    expect(query.sql).toMatch(
      /codex_thread_id = CASE\s+WHEN \$\d+::boolean\s+AND \$\d+::text IS DISTINCT FROM runtime\.engine/u,
    );
    expect(query.params).toContain(false);
  });

  it.each([
    { turnStatus: "failed" as const, terminalEvent: "run.failed", error: "Provider failed." },
    { turnStatus: "interrupted" as const, terminalEvent: "run.canceled", error: null },
  ])("orders the complete Message snapshot before $terminalEvent", async ({
    turnStatus,
    terminalEvent,
    error,
  }) => {
    await settleDurableTurn({
      target: {
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        codexChatSessionId: "runtime_1",
        chatSessionId: "goat_chat_1",
        turnId: "turn_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
      },
      turnStatus,
      sessionStatus: turnStatus === "interrupted" ? "interrupted" : "idle",
      error,
      completedAt: new Date("2026-07-30T09:30:00.000Z"),
      canonicalRun: {
        attemptId: "attempt_1",
        assistantMessageId: "assistant_message_1",
        content: "Latest response",
      },
    });

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]?.[0]);
    expect(canonicalEventTypes(query.params)).toEqual(["message.content_updated", terminalEvent]);
  });

  it("stores an internal Attempt diagnostic separately from the user-facing Run error", async () => {
    await settleDurableTurn({
      target: {
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        codexChatSessionId: "runtime_1",
        chatSessionId: "conversation_1",
        turnId: "turn_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
      },
      turnStatus: "failed",
      sessionStatus: "idle",
      error: "Repository preparation failed.",
      completedAt: new Date("2026-07-30T09:30:00.000Z"),
      canonicalRun: {
        attemptId: "attempt_1",
        assistantMessageId: "assistant_message_1",
        content: "Latest response",
        failureDiagnostic: "[load_bootstrap] DatabaseError: connection closed",
      },
    });

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]?.[0]);
    expect(query.params).toContain("Repository preparation failed.");
    expect(query.params).toContain("[load_bootstrap] DatabaseError: connection closed");
    expect(query.params).toContainEqual(
      expect.stringContaining('"message":"Repository preparation failed."'),
    );
  });

  it("bounds coding-session and turn errors at durable settlement", async () => {
    const overlongError = `${"x".repeat(2_000)}private-tail`;
    const boundedError = overlongError.slice(0, 2_000);

    await settleDurableTurn({
      target: {
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        codexChatSessionId: "runtime_1",
        chatSessionId: "conversation_1",
        turnId: "turn_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
      },
      turnStatus: "failed",
      sessionStatus: "failed",
      error: overlongError,
      completedAt: new Date("2026-07-30T09:30:00.000Z"),
      canonicalRun: {
        attemptId: "attempt_1",
        assistantMessageId: "assistant_message_1",
        content: "Latest response",
      },
    });

    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("UPDATE goat.codex_chat_turns AS turn");
    expect(query.sql).toContain("UPDATE goat.codex_chat_sessions AS runtime");
    expect(query.params.filter((value) => value === boundedError).length).toBeGreaterThanOrEqual(3);
    expect(
      query.params.every((value) => typeof value !== "string" || !value.includes("private-tail")),
    ).toBe(true);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "Normalized overlong coding error before durable settlement",
      {
        event: "opencompany.runner_coding_error_normalized",
        field: "error",
        original_length: overlongError.length,
        max_length: 2_000,
      },
    );
    expect(loggerMocks.warn.mock.calls[0]?.[1]).not.toHaveProperty("error");
  });

  it("settles the current lease and queues the next workflow Run in the same Conversation", async () => {
    const completion = buildTaskTurnCompletion({
      context: context(workflowSpec()),
      result: "Repository audit complete.",
      reportedOutcome: "done",
      outcomeComment: "Ready.",
    });
    expect(completion.nextTurn).not.toBeNull();

    await settleDurableTurn({
      target: {
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        codexChatSessionId: "runtime_1",
        chatSessionId: "goat_chat_task_1",
        turnId: "turn_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
      },
      turnStatus: "completed",
      sessionStatus: "idle",
      error: null,
      completedAt: new Date("2026-07-30T09:30:00.000Z"),
      taskCompletion: completion,
    });

    const statement = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0]?.[0]).sql;
    expect(statement).toContain("WITH settled_turn AS");
    expect(statement).toContain("UPDATE goat.tasks AS task");
    expect(statement).toContain("tagged_current_task_messages AS");
    expect(statement).toContain("SET task_id = task.id");
    expect(statement).not.toContain("created_next_chat AS");
    expect(statement).not.toContain("created_next_runtime AS");
    expect(statement).toContain("INSERT INTO goat.chat_messages");
    expect(statement).toContain("task_id");
    expect(statement).toContain("debug_trace");
    expect(statement).toContain("attachment_texts");
    expect(statement).toContain("INSERT INTO goat.codex_chat_turns");
    expect(statement).toContain("run_after");
    expect(statement).toContain("event_sequence");
    expect(statement).toContain("next_queued_event AS");
    expect(statement).toContain("'run.queued'");
    expect(statement).not.toMatch(/'triggerMessageId', next\.user_message_id,\s*'taskId'/u);
    expect(statement).toContain("notified_next_queued_event AS");
    expect(statement).toContain("UPDATE goat.codex_chat_sessions AS runtime");
    expect(statement).toMatch(
      /codex_thread_id = CASE\s+WHEN \$\d+::boolean\s+AND \$\d+::text IS DISTINCT FROM runtime\.engine/u,
    );
    expect(statement).toContain("task.status IN ('queued', 'running')");
    expect(statement).toContain("SELECT next.id");
    expect(statement).toContain("FROM next_turn AS next");
    expect(statement).toContain("NOT EXISTS (SELECT 1 FROM next_turn)");
    expect(statement).toContain("existing.debug_trace->'taskNotification'->>'taskId'");
    expect(statement).not.toContain("goat.task_messages");
    expect(statement).not.toContain("goat.task_events");
    expect(analyticsMocks.captureProductServerEvent).toHaveBeenCalledWith(
      "chat_message_sent",
      "user_1",
      {
        workspace_id: "workspace_1",
        session_id: "goat_chat_task_1",
        is_first_message: false,
        engine: "codex",
        usage_source: "external_harness",
        model: completion.nextTurn?.chatModel,
        message_length: completion.nextTurn?.prompt.length,
      },
    );
  });
});

function canonicalEventTypes(params: unknown[]) {
  const serialized = params.find(
    (value) => typeof value === "string" && value.includes('"message.content_updated"'),
  );
  if (typeof serialized !== "string") throw new Error("Canonical Run Events were not serialized.");
  return (JSON.parse(serialized) as Array<{ type: string }>).map((event) => event.type);
}

function durableTurn(): CodexChatTurn {
  const now = new Date("2026-07-30T09:00:00.000Z");
  return {
    id: "turn_1",
    userWorkosId: "user_1",
    codexChatSessionId: "runtime_1",
    chatSessionId: "goat_chat_task_1",
    userMessageId: "user_message_1",
    assistantMessageId: "assistant_message_1",
    codexTurnId: null,
    status: "running",
    prompt: "Ship the requested change.",
    settings: {},
    error: null,
    interruptRequestedAt: null,
    attempts: 1,
    recoveryAttempts: 0,
    engineRecoveryRequired: false,
    engineTurnBaselineIds: null,
    eventSequence: 0,
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date(now.getTime() + 300_000),
    runAfter: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function workflowSpec(): HarnessSpec {
  return {
    schemaVersion: "goat.harness.v1",
    engine: "opencompany",
    model: "moonshotai/kimi-k2.6",
    systemPrompt: "Audit the repository.",
    systemBlocks: ["Audit the repository."],
    initialUserMessage: "Ship the requested change.",
    tools: ["github_status"],
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
    workflow: {
      id: "workflow_1",
      workspaceId: "workspace_1",
      skillIds: [],
      currentStepIndex: 0,
      completedStepCount: 0,
      steps: [
        {
          index: 0,
          title: "Audit",
          engine: "opencompany",
          model: "moonshotai/kimi-k2.6",
          systemPrompt: "Audit the repository.",
          systemBlocks: ["Audit the repository."],
          skillIds: [],
        },
        {
          index: 1,
          title: "Implement",
          engine: "codex",
          model: "openai/gpt-5.5",
          systemPrompt: "Implement and verify the change.",
          systemBlocks: ["Implement and verify the change."],
          skillIds: [],
        },
      ],
    },
  };
}

function context(harnessSpec: HarnessSpec): TaskTurnContext {
  return {
    task: task(harnessSpec),
    harnessSpec,
  };
}

function task(harnessSpec: HarnessSpec): Task {
  const now = new Date("2026-07-30T09:00:00.000Z");
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Ship workflow",
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    prompt: "Ship the requested change.",
    source: "workflow",
    model: harnessSpec.model,
    sessionId: "goat_chat_task_1",
    scheduleId: null,
    scheduledFor: null,
    status: "running",
    stage: "running",
    result: null,
    error: null,
    workflowId: "workflow_1",
    workflowBrainRef: null,
    reportedOutcome: null,
    outcomeComment: null,
    harnessSpec,
    debugTrace: {},
    codexEngineSessionId: null,
    sandboxId: null,
    attempts: 1,
    nextRunAt: now,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
