import { GOAT_ACTION_HOST_TOOL_CONTRACT_VERSION } from "@opencompany/agent-runtime";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { GoatChatMessageAttachment, GoatHarnessSpec } from "./schema";
import { createGoatTaskSession, enqueueGoatTaskSessionTurn } from "./task-sessions";

const harnessSpec: GoatHarnessSpec = {
  schemaVersion: "goat.harness.v1",
  engine: "opencompany",
  model: "moonshotai/kimi-k2.6",
  systemPrompt: "",
  initialUserMessage: "Research the market.",
  tools: ["exa_search"],
  skills: [],
  maxModelSteps: 16,
  resultMode: "assistant_final",
};

describe("Goat task sessions", () => {
  it("creates the task projection, native messages, runtime, and first turn in one statement", async () => {
    const execute = vi.fn(async (_query: SQL) => [taskRow()]);

    await expect(
      createGoatTaskSession(
        {
          userWorkosId: "user_1",
          workspaceId: "workspace_1",
          brainRef: "brain_1",
          prompt: "Research the market.",
          name: "Market research",
          harnessSpec,
          attachments: [attachment],
          attachmentTexts: { [attachment.id]: "Extracted report text." },
          now: new Date("2026-07-30T09:00:00.000Z"),
        },
        { execute },
      ),
    ).resolves.toMatchObject({
      id: "goat_task_1",
      sessionId: "goat_chat_1",
      status: "queued",
    });

    const query = rendered(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("INSERT INTO goat.chat_sessions");
    expect(query.sql).toContain("INSERT INTO goat.tasks");
    expect(query.sql).toContain("INSERT INTO goat.chat_messages");
    expect(query.sql).toContain("attachments");
    expect(query.sql).toContain("attachment_texts");
    expect(query.sql).toContain("INSERT INTO goat.codex_chat_sessions");
    expect(query.sql).toContain("INSERT INTO goat.codex_chat_turns");
    expect(query.sql).not.toContain("goat.task_messages");
    expect(query.sql).not.toContain("goat.task_events");
    expect(query.sql).not.toContain("CROSS JOIN resolved_workspace");
    expect(query.sql).toContain("(SELECT workspace_id FROM resolved_workspace)");
    expect(query.sql).toContain("'task'");
    expect(query.params).toContain("workspace_1");
    expect(query.params).toContain("brain_1");
    expect(query.params).toContain(JSON.stringify([attachment]));
    expect(query.params).toContain(JSON.stringify({ [attachment.id]: "Extracted report text." }));
  });

  it("does not require workspace membership to create a scheduled task session", async () => {
    const execute = vi.fn(async (_query: SQL) => [taskRow()]);

    await expect(
      createGoatTaskSession(
        {
          userWorkosId: "user_1",
          prompt: "Research the market.",
          name: "Market research",
          harnessSpec,
          now: new Date("2026-07-30T09:00:00.000Z"),
        },
        { execute },
      ),
    ).resolves.toMatchObject({ id: "goat_task_1" });

    const query = rendered(execute.mock.calls[0]?.[0]);
    expect(query.sql).not.toContain("CROSS JOIN resolved_workspace");
    expect(query.sql).toContain("(SELECT workspace_id FROM resolved_workspace)");
    expect(query.params).toContain(null);
  });

  it("creates Claude Code task sessions with the CLI model and sandbox host-tool contract", async () => {
    const execute = vi.fn(async (_query: SQL) => [taskRow(claudeCodeHarnessSpec)]);

    await expect(
      createGoatTaskSession(
        {
          userWorkosId: "user_1",
          workspaceId: "workspace_1",
          prompt: "Fix the workflow.",
          name: "Fix workflow",
          harnessSpec: claudeCodeHarnessSpec,
          now: new Date("2026-07-30T09:00:00.000Z"),
        },
        { execute },
      ),
    ).resolves.toMatchObject({
      id: "goat_task_1",
      model: "anthropic/claude-sonnet-5",
    });

    const query = rendered(execute.mock.calls[0]?.[0]);
    expect(query.params).toContain("claude_code");
    expect(query.params).toContain("anthropic/claude-sonnet-5");
    expect(query.params).toContain("claude-sonnet-5");
    expect(query.params).toContain(GOAT_ACTION_HOST_TOOL_CONTRACT_VERSION);
  });

  it("continues a terminal task by appending native chat messages and a turn", async () => {
    const execute = vi.fn(async (_query: SQL) => [
      { id: "goat_chat_msg_1", task_id: "goat_task_1" },
    ]);

    await expect(
      enqueueGoatTaskSessionTurn(
        {
          taskId: "goat_task_1",
          userWorkosId: "user_1",
          prompt: "Now compare the top two.",
          now: new Date("2026-07-30T10:00:00.000Z"),
        },
        { execute },
      ),
    ).resolves.toEqual({ id: "goat_chat_msg_1", task_id: "goat_task_1" });

    const query = rendered(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("UPDATE goat.tasks AS task");
    expect(query.sql).toContain("INSERT INTO goat.chat_messages");
    expect(query.sql).toContain("INSERT INTO goat.codex_chat_turns");
    expect(query.sql).toContain("active_turn.status IN ('queued', 'running')");
    expect(query.sql).not.toContain("goat.task_messages");
    expect(query.sql).not.toContain("goat.task_events");
  });
});

function rendered(query: SQL | undefined) {
  expect(query).toBeDefined();
  return new PgDialect().sqlToQuery(query!);
}

const claudeCodeHarnessSpec: GoatHarnessSpec = {
  ...harnessSpec,
  engine: "claude_code",
  model: "anthropic/claude-sonnet-5",
};

const attachment: GoatChatMessageAttachment = {
  id: "goat_chat_att_1",
  kind: "docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  filename: "report.docx",
  sizeBytes: 1024,
  blobPathname: "goat-chat/user_1/report.docx",
  blobUrl: "https://blob.test/goat-chat/user_1/report.docx",
};

function taskRow(spec: GoatHarnessSpec = harnessSpec) {
  const now = new Date("2026-07-30T09:00:00.000Z");
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Market research",
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    prompt: "Research the market.",
    model: spec.model,
    sessionId: "goat_chat_1",
    scheduleId: null,
    scheduledFor: null,
    status: "queued",
    stage: "queued",
    result: null,
    error: null,
    workflowId: null,
    workflowBrainRef: null,
    reportedOutcome: null,
    outcomeComment: null,
    harnessSpec: spec,
    debugTrace: {},
    codexEngineSessionId: null,
    sandboxId: null,
    attempts: 0,
    nextRunAt: now,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
