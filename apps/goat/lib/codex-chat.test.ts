import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveGoatChatSessionForUser,
  createGoatCodexChatMessage as createGoatCodexChatMessageImpl,
  createGoatCodingWorkspaceRuntimeAccess,
  getGoatCodexChatSandboxStatus,
  interruptGoatCodexChatSession,
} from "@/lib/codex-chat";

const createGoatCodexChatMessage = (
  input: Omit<Parameters<typeof createGoatCodexChatMessageImpl>[0], "workspaceId">,
) => createGoatCodexChatMessageImpl({ ...input, workspaceId: "workspace_1" });

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  selectResults: [] as unknown[][],
  codexConnected: vi.fn(),
  claudeConnected: vi.fn(),
  getSandboxStatus: vi.fn(),
  killSandbox: vi.fn(),
  runtimeAccess: vi.fn(),
  wake: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    execute: mocks.execute,
    select: mocks.select,
  }),
}));

vi.mock("@/lib/codex-auth", () => ({
  isGoatCodexConnectedForUser: mocks.codexConnected,
}));

// Pulls in @/lib/auth (authkit), which vitest cannot resolve.
vi.mock("@/lib/claude-code-auth", () => ({
  isGoatClaudeCodeConnectedForUser: mocks.claudeConnected,
}));

vi.mock("@/lib/task-runner", () => ({
  requestGoatCodingWorkspaceRuntimeAccess: mocks.runtimeAccess,
  GoatCodingWorkspaceRequestError: class GoatCodingWorkspaceRequestError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  },
  getGoatCodexSandboxStatus: mocks.getSandboxStatus,
  killGoatCodexSandbox: mocks.killSandbox,
  triggerGoatCodexChatWake: mocks.wake,
}));

vi.mock("@/lib/chat", () => ({
  newGoatChatMessageId: vi.fn(() => "goat_chat_msg_mock"),
}));

function sqlText(query: unknown) {
  const chunks =
    (query as { queryChunks?: Array<string | { value?: string[] }> } | undefined)?.queryChunks ??
    [];
  return chunks
    .map((chunk) => (typeof chunk === "string" ? "?" : ((chunk?.value ?? []) as string[]).join("")))
    .join("");
}

function createSelectBuilder(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.limit = vi.fn(async () => rows);
  return builder;
}

describe("createGoatCodexChatMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.codexConnected.mockResolvedValue(true);
    mocks.claudeConnected.mockResolvedValue(true);
    mocks.wake.mockResolvedValue(undefined);
    mocks.select.mockImplementation(() => createSelectBuilder(mocks.selectResults.shift() ?? []));
  });

  it("rejects empty and oversized prompts", async () => {
    expect(
      await createGoatCodexChatMessage({ userWorkosId: "user_1", prompt: "   " }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await createGoatCodexChatMessage({ userWorkosId: "user_1", prompt: "x".repeat(10_001) }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects invalid Codex settings before writing", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "hello",
      settings: { reasoningEffort: "extreme" },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Invalid Codex reasoning effort.",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("rejects models outside the supported Codex catalog", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "hello",
      model: "openai/gpt-5.4-nano",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Select a supported Codex model.",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("rejects invalid Claude settings before writing", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "hello",
      engine: "claude_code",
      settings: { reasoningEffort: "max" },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Invalid Claude reasoning effort.",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects sends while Codex is disconnected", async () => {
    mocks.codexConnected.mockResolvedValue(false);
    const result = await createGoatCodexChatMessage({ userWorkosId: "user_1", prompt: "hello" });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("creates a new session atomically and wakes the runner", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      brainRef: "brain_1",
      prompt: "clone my repo",
      clientMessageId: "client_msg_1",
    });
    expect(result).toMatchObject({
      ok: true,
      mode: "started",
      userMessageId: "client_msg_1",
      assistantMessageId: "goat_chat_msg_mock",
    });
    // The whole send (session + both messages + codex session + turn) is one statement.
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const statement = mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    expect(sqlText(statement)).toContain("'queued'");
    expect(sqlText(statement)).toContain("brain_ref, workspace_id");
    expect(statement.queryChunks).toContain("brain_1");
    expect(statement.queryChunks).toContain("workspace_1");
    expect(statement.queryChunks).toContain("goat-codex-host-tools.v3");
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });

  it("persists immutable native skill snapshots with the first session turn", async () => {
    await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "Implement this",
      skills: [
        {
          id: "coding-work",
          brainRef: "brain_1",
          name: "Coding work",
          description: "How coding work should happen.",
          instructions: "Inspect, implement, and verify.",
        },
      ],
    });

    const statement = mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    const serialized = JSON.stringify(statement.queryChunks);
    expect(serialized).toContain("Implement this");
    expect(serialized).toContain("coding-work");
    expect(serialized).toContain("Inspect, implement, and verify.");
    expect(sqlText(statement)).toContain("INSERT INTO goat.chat_session_skills");
  });

  it("persists attachments and allows an attachment-only first turn", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "",
      attachments: [
        {
          id: "goat_chat_att_1",
          kind: "image",
          mediaType: "image/png",
          filename: "screenshot.png",
          sizeBytes: 1024,
          blobPathname: "goat-chat/user_1/screenshot.png",
          blobUrl: "https://blob.test/goat-chat/user_1/screenshot.png",
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "started",
      analytics: {
        isFirstMessage: true,
        engine: "codex",
        model: "openai/gpt-5.6-sol",
      },
    });
    const statement = mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    expect(JSON.stringify(statement.queryChunks)).toContain("screenshot.png");
  });

  it("persists the selected Codex model on a new chat and engine session", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "clone my repo",
      model: "openai/gpt-5.6-terra",
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "started",
      analytics: {
        isFirstMessage: true,
        engine: "codex",
        model: "openai/gpt-5.6-terra",
      },
    });
    const statement = mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    expect(statement.queryChunks).toContain("openai/gpt-5.6-terra");
    expect(statement.queryChunks).toContain("gpt-5.6-terra");
  });

  it("persists the selected Claude model and effort on a new chat", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "clone my repo",
      engine: "claude_code",
      model: "anthropic/claude-opus-4.8",
      settings: { reasoningEffort: "xhigh" },
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "started",
      analytics: {
        isFirstMessage: true,
        engine: "claude_code",
        model: "anthropic/claude-opus-4.8",
      },
    });
    const statement = mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    expect(statement.queryChunks).toContain("anthropic/claude-opus-4.8");
    expect(statement.queryChunks).toContain("claude-opus-4-8");
    expect(statement.queryChunks).toContain('{"reasoningEffort":"xhigh"}');
  });

  it("enqueues an internal OpenCompany turn without coding credentials or sandbox state", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "Summarize the launch notes",
      engine: "opencompany",
      model: "anthropic/claude-sonnet-5",
    });

    expect(result).toMatchObject({
      ok: true,
      mode: "started",
      analytics: {
        isFirstMessage: true,
        engine: "opencompany",
        model: "anthropic/claude-sonnet-5",
      },
    });
    expect(mocks.codexConnected).not.toHaveBeenCalled();
    expect(mocks.claudeConnected).not.toHaveBeenCalled();
    const statement = mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    expect(statement.queryChunks).toContain("opencompany");
    expect(statement.queryChunks).toContain("anthropic/claude-sonnet-5");
    expect(JSON.stringify(statement.queryChunks)).toContain("opencompany.chat.debug.v1");
    expect(statement.queryChunks).not.toContain("goat-codex-host-tools.v3");
  });

  it("rejects unsupported models for an internal OpenCompany enqueue", async () => {
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      prompt: "hello",
      engine: "opencompany",
      model: "openai/not-a-model",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Select a supported Goat model.",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown or foreign session", async () => {
    mocks.selectResults.push([]);
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      sessionId: "goat_chat_other",
      prompt: "hello",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("queues a message while the session is running", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          engine: "codex",
          model: "gpt-5.6-terra",
          status: "running",
        },
        chat_sessions: {
          model: "openai/gpt-5.6-terra",
        },
      },
    ]);
    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      sessionId: "goat_chat_1",
      prompt: "also do this",
    });
    expect(result).toMatchObject({
      ok: true,
      mode: "queued",
      sessionId: "goat_chat_1",
      analytics: {
        isFirstMessage: false,
        engine: "codex",
        model: "openai/gpt-5.6-terra",
      },
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });

  it("supersedes every queued scheduled wakeup when a real user message arrives", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          engine: "claude_code",
          model: "claude-opus-4-8",
          status: "idle",
        },
        chat_sessions: {
          model: "anthropic/claude-opus-4.8",
        },
      },
    ]);

    await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      sessionId: "goat_chat_1",
      prompt: "I have an update",
      engine: "claude_code",
    });

    const statement = sqlText(mocks.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("cancelled_wakeups AS");
    expect(statement).toContain("status = 'interrupted'");
    expect(statement).toContain("run_after IS NOT NULL");
    expect(statement).toContain("'aborted'");
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(sqlText(mocks.execute.mock.calls[1]?.[0])).toContain("run_after IS NOT NULL");
  });

  it("persists newly activated native skill snapshots with queued turns", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          engine: "codex",
          model: "gpt-5.6-sol",
          status: "running",
        },
        chat_sessions: {
          model: "openai/gpt-5.6-sol",
        },
      },
    ]);
    await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      sessionId: "goat_chat_1",
      prompt: "Implement this",
      skills: [
        {
          id: "coding-work",
          brainRef: "brain_1",
          name: "Coding work",
          description: "How coding work should happen.",
          instructions: "Inspect, implement, and verify.",
        },
      ],
    });

    const statement = mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    const serialized = JSON.stringify(statement.queryChunks);
    expect(serialized).toContain("Implement this");
    expect(serialized).toContain("coding-work");
    expect(sqlText(statement)).toContain("ON CONFLICT (chat_session_id, skill_id) DO NOTHING");
  });

  it.each([
    "idle",
    "failed",
    "interrupted",
  ] as const)("marks a %s session as queued and clears its previous error when retrying", async (status) => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          engine: "codex",
          model: "gpt-5.6-sol",
          status,
          error: "Previous turn failed.",
        },
        chat_sessions: {
          model: "openai/gpt-5.6-sol",
        },
      },
    ]);

    const result = await createGoatCodexChatMessage({
      userWorkosId: "user_1",
      sessionId: "goat_chat_1",
      prompt: "try again",
    });

    expect(result).toMatchObject({ ok: true, mode: "started" });
    const statement = sqlText(mocks.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("UPDATE goat.codex_chat_sessions AS session");
    expect(statement).toContain("ELSE 'queued'");
    expect(statement).toContain("active_turn_id = CASE");
    expect(statement).toContain("error = NULL");
  });

  it("still succeeds when the runner wake fails", async () => {
    mocks.wake.mockRejectedValue(new Error("runner offline"));
    const result = await createGoatCodexChatMessage({ userWorkosId: "user_1", prompt: "hello" });
    expect(result).toMatchObject({ ok: true });
  });
});

describe("interruptGoatCodexChatSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.select.mockImplementation(() => createSelectBuilder(mocks.selectResults.shift() ?? []));
  });

  it("returns 404 for an unknown session", async () => {
    mocks.selectResults.push([]);
    const result = await interruptGoatCodexChatSession({
      userWorkosId: "user_1",
      chatSessionId: "goat_chat_unknown",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("flags running turns and cancels queued turns", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          status: "running",
        },
        chat_sessions: {
          model: "openai/gpt-5.6-sol",
        },
      },
    ]);
    const result = await interruptGoatCodexChatSession({
      userWorkosId: "user_1",
      chatSessionId: "goat_chat_1",
    });
    expect(result).toMatchObject({ ok: true, status: 202 });
    // One UPDATE for the running turn's interrupt flag, one CTE for queued-turn cancellation,
    // and one session settle for the case where no running turn is left to do it.
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });

  it("keeps the OpenCompany debug schema when canceling a queued internal turn", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          engine: "opencompany",
          model: "anthropic/claude-sonnet-5",
          status: "queued",
        },
        chat_sessions: {
          model: "anthropic/claude-sonnet-5",
        },
      },
    ]);

    await interruptGoatCodexChatSession({
      userWorkosId: "user_1",
      chatSessionId: "goat_chat_1",
    });

    expect(JSON.stringify(mocks.execute.mock.calls[1]?.[0])).toContain("opencompany.chat.debug.v1");
  });

  it.each([
    "queued",
    "starting",
  ] as const)("settles a %s session so a pre-run stop cannot wedge the spinner", async (status) => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          status,
        },
        chat_sessions: {
          model: "openai/gpt-5.6-sol",
        },
      },
    ]);
    const result = await interruptGoatCodexChatSession({
      userWorkosId: "user_1",
      chatSessionId: "goat_chat_1",
    });
    expect(result).toMatchObject({ ok: true, status: 202 });
    const settleSql = sqlText(mocks.execute.mock.calls.at(-1)?.[0]);
    expect(settleSql).toContain("UPDATE goat.codex_chat_sessions");
    expect(settleSql).toContain("'interrupted'");
    expect(settleSql).toContain("NOT EXISTS");
    expect(settleSql).toContain("status IN ('queued', 'starting', 'running')");
  });
});

describe("archiveGoatChatSessionForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.killSandbox.mockResolvedValue(true);
  });

  it("archives the chat, stops queued and running turns, and kills its sandbox", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "goat_chat_1", sandboxId: "sbx_123" }] });

    await expect(
      archiveGoatChatSessionForUser({
        userWorkosId: "user_1",
        chatSessionId: "goat_chat_1",
      }),
    ).resolves.toBe(true);

    const statement = sqlText(mocks.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("archived_chat AS MATERIALIZED");
    expect(statement).toContain("chat.closed_at IS NULL");
    expect(statement).toContain("turn.status IN ('queued', 'running')");
    expect(statement).toContain("interrupt_requested_at");
    expect(statement).toContain("WHEN turn.status = 'queued' THEN 'interrupted'");
    expect(statement).toContain("SET status = 'closed'");
    expect(mocks.killSandbox).toHaveBeenCalledWith("sbx_123");
  });

  it("returns false when the owned open chat did not match", async () => {
    await expect(
      archiveGoatChatSessionForUser({
        userWorkosId: "user_1",
        chatSessionId: "goat_chat_missing",
      }),
    ).resolves.toBe(false);
    expect(mocks.killSandbox).not.toHaveBeenCalled();
  });

  it("archives a chat without a coding runtime", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "goat_chat_plain", sandboxId: null }] });

    await expect(
      archiveGoatChatSessionForUser({
        userWorkosId: "user_1",
        chatSessionId: "goat_chat_plain",
      }),
    ).resolves.toBe(true);

    expect(mocks.killSandbox).not.toHaveBeenCalled();
  });

  it("does not fail the durable archive when the sandbox kill fails", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "goat_chat_1", sandboxId: "sbx_123" }] });
    mocks.killSandbox.mockRejectedValue(new Error("runner down"));

    await expect(
      archiveGoatChatSessionForUser({
        userWorkosId: "user_1",
        chatSessionId: "goat_chat_1",
      }),
    ).resolves.toBe(true);
  });
});

describe("getGoatCodexChatSandboxStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.getSandboxStatus.mockResolvedValue("running");
    mocks.select.mockImplementation(() => createSelectBuilder(mocks.selectResults.shift() ?? []));
  });

  it("returns null before a sandbox has been persisted", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          sandboxId: null,
          status: "queued",
        },
        chat_sessions: {
          model: "openai/gpt-5.6-sol",
        },
      },
    ]);

    await expect(
      getGoatCodexChatSandboxStatus({
        userWorkosId: "user_1",
        chatSessionId: "goat_chat_1",
      }),
    ).resolves.toEqual({ ok: true, status: null });
    expect(mocks.getSandboxStatus).not.toHaveBeenCalled();
  });

  it("loads the runner status for the session sandbox", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          sandboxId: "sbx_123",
          status: "idle",
        },
        chat_sessions: {
          model: "openai/gpt-5.6-sol",
        },
      },
    ]);
    mocks.getSandboxStatus.mockResolvedValue("sleeping");

    await expect(
      getGoatCodexChatSandboxStatus({
        userWorkosId: "user_1",
        chatSessionId: "goat_chat_1",
      }),
    ).resolves.toEqual({ ok: true, status: "sleeping" });
    expect(mocks.getSandboxStatus).toHaveBeenCalledWith("sbx_123");
  });
});

describe("createGoatCodingWorkspaceRuntimeAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.select.mockImplementation(() => createSelectBuilder(mocks.selectResults.shift() ?? []));
  });

  it("resolves the owner-bound Codex session without exposing its sandbox id", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          userWorkosId: "user_1",
          engine: "codex",
          sandboxId: "sbx_secret",
          status: "idle",
        },
        chat_sessions: {
          model: "openai/gpt-5.6-sol",
        },
      },
    ]);
    mocks.runtimeAccess.mockResolvedValue({
      websocketUrl: "wss://runner.example.com/goat/runtime",
      ticket: "ticket_1",
      expiresAt: 60_000,
      sandboxStatus: "sleeping",
    });

    const result = await createGoatCodingWorkspaceRuntimeAccess({
      userWorkosId: "user_1",
      chatSessionId: "goat_chat_1",
    });

    expect(result).toMatchObject({
      ok: true,
      access: { ticket: "ticket_1", sandboxStatus: "sleeping" },
    });
    expect(result).not.toHaveProperty("access.sandboxId");
    expect(mocks.runtimeAccess).toHaveBeenCalledWith({
      codingSessionId: "goat_codex_chat_1",
      userWorkosId: "user_1",
    });
  });

  it("rejects foreign sessions before asking the runner for a ticket", async () => {
    mocks.selectResults.push([]);

    await expect(
      createGoatCodingWorkspaceRuntimeAccess({
        userWorkosId: "user_other",
        chatSessionId: "goat_chat_1",
      }),
    ).resolves.toMatchObject({ ok: false, statusCode: 404 });
    expect(mocks.runtimeAccess).not.toHaveBeenCalled();
  });

  it("resolves owner-bound Claude Code sessions through the shared workspace runtime", async () => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          userWorkosId: "user_1",
          engine: "claude_code",
          sandboxId: "sbx_secret",
          status: "idle",
        },
        chat_sessions: {
          model: "anthropic/claude-sonnet-4-6",
        },
      },
    ]);

    mocks.runtimeAccess.mockResolvedValue({
      websocketUrl: "wss://runner.example.com/goat/runtime",
      ticket: "ticket_claude",
      expiresAt: 60_000,
      sandboxStatus: "running",
    });

    await expect(
      createGoatCodingWorkspaceRuntimeAccess({
        userWorkosId: "user_1",
        chatSessionId: "goat_chat_1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      access: { ticket: "ticket_claude", sandboxStatus: "running" },
    });
    expect(mocks.runtimeAccess).toHaveBeenCalledWith({
      codingSessionId: "goat_codex_chat_1",
      userWorkosId: "user_1",
    });
  });

  it.each([
    ["closed", "codex", "sbx_secret", "closed", 404],
    ["unsupported", "opencompany", "sbx_secret", "idle", 404],
    ["missing sandbox", "codex", null, "idle", 409],
  ])("rejects %s sessions before asking the runner for a ticket", async (_case, engine, sandboxId, status, statusCode) => {
    mocks.selectResults.push([
      {
        codex_chat_sessions: {
          id: "goat_codex_chat_1",
          chatSessionId: "goat_chat_1",
          userWorkosId: "user_1",
          engine,
          sandboxId,
          status,
        },
        chat_sessions: {
          model: "openai/gpt-5.6-sol",
        },
      },
    ]);

    await expect(
      createGoatCodingWorkspaceRuntimeAccess({
        userWorkosId: "user_1",
        chatSessionId: "goat_chat_1",
      }),
    ).resolves.toMatchObject({ ok: false, statusCode });
    expect(mocks.runtimeAccess).not.toHaveBeenCalled();
  });
});
