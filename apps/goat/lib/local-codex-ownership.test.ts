import type {
  GoatLocalBridge,
  GoatLocalCodexCommand,
  GoatLocalCodexSession,
  GoatLocalCodexTurn,
} from "@opencompany/db/goat-schema";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimLocalCodexCommandsForBridge,
  completeLocalCodexCommand,
  recordLocalCodexBridgeEvents,
} from "@/lib/local-codex";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  insert: vi.fn(),
  insertBuilders: [] as ReturnType<typeof createInsertBuilder>[],
  returningResults: [] as unknown[][],
  select: vi.fn(),
  selectBuilders: [] as ReturnType<typeof createSelectBuilder>[],
  selectResults: [] as unknown[][],
  update: vi.fn(),
  updateBuilders: [] as ReturnType<typeof createUpdateBuilder>[],
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    execute: mocks.execute,
    insert: mocks.insert,
    select: mocks.select,
    update: mocks.update,
  }),
}));

vi.mock("@/lib/chat", () => ({
  newGoatChatMessageId: vi.fn(() => "goat_chat_msg_mock"),
}));

const pgDialect = new PgDialect();

describe("local Codex bridge ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertBuilders.length = 0;
    mocks.returningResults.length = 0;
    mocks.selectBuilders.length = 0;
    mocks.selectResults.length = 0;
    mocks.updateBuilders.length = 0;

    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.insert.mockImplementation(() => {
      const builder = createInsertBuilder();
      mocks.insertBuilders.push(builder);
      return builder;
    });
    mocks.select.mockImplementation(() => {
      const builder = createSelectBuilder();
      mocks.selectBuilders.push(builder);
      return builder;
    });
    mocks.update.mockImplementation(() => {
      const builder = createUpdateBuilder();
      mocks.updateBuilders.push(builder);
      return builder;
    });
  });

  it("claims bridge commands only for the bridge user's command rows", async () => {
    await claimLocalCodexCommandsForBridge({ bridge: bridgeFixture(), limit: 5 });

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(renderSql(mocks.execute.mock.calls[0]?.[0])).toContain("WHERE user_workos_id = $1");
  });

  it("completes only commands currently claimed by that user's bridge", async () => {
    mocks.returningResults.push([
      commandFixture({
        localCodexTurnId: null,
        status: "succeeded",
      }),
    ]);

    await expect(
      completeLocalCodexCommand({
        bridge: bridgeFixture(),
        commandId: "goat_local_codex_cmd_1",
        status: "succeeded",
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(renderSql(mocks.updateBuilders[0]?.whereValue)).toBe(
      '("goat"."local_codex_commands"."id" = $1 and "goat"."local_codex_commands"."user_workos_id" = $2 and "goat"."local_codex_commands"."status" = $3 and "goat"."local_codex_commands"."claimed_by_bridge_id" = $4)',
    );
    expect(renderSql(mocks.updateBuilders[1]?.whereValue)).toBe(
      '("goat"."local_codex_sessions"."id" = $1 and "goat"."local_codex_sessions"."user_workos_id" = $2)',
    );
  });

  it("rejects bridge events for commands outside the bridge session", async () => {
    mocks.selectResults.push([localSessionFixture()], []);

    await expect(
      recordLocalCodexBridgeEvents({
        bridge: bridgeFixture(),
        localCodexSessionId: "goat_local_codex_1",
        commandId: "goat_local_codex_cmd_foreign",
        events: [{ method: "turn/started", params: { turn: { id: "codex_turn_1" } } }],
      }),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      error: "Local Codex command not found.",
    });

    expect(renderSql(mocks.selectBuilders[1]?.whereValue)).toContain(
      '"goat"."local_codex_commands"."user_workos_id" = $2',
    );
    expect(renderSql(mocks.selectBuilders[1]?.whereValue)).toContain(
      '"goat"."local_codex_commands"."local_codex_session_id" = $3',
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects bridge events for turns outside the bridge session", async () => {
    mocks.selectResults.push([localSessionFixture()], []);

    await expect(
      recordLocalCodexBridgeEvents({
        bridge: bridgeFixture(),
        localCodexSessionId: "goat_local_codex_1",
        localCodexTurnId: "goat_local_codex_turn_foreign",
        events: [{ method: "turn/started", params: { turn: { id: "codex_turn_1" } } }],
      }),
    ).resolves.toEqual({
      ok: false,
      status: 404,
      error: "Local Codex turn not found.",
    });

    expect(renderSql(mocks.selectBuilders[1]?.whereValue)).toBe(
      '("goat"."local_codex_turns"."id" = $1 and "goat"."local_codex_turns"."user_workos_id" = $2 and "goat"."local_codex_turns"."local_codex_session_id" = $3)',
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("stores valid bridge events against the scoped local turn", async () => {
    mocks.selectResults.push([localSessionFixture()], [localTurnFixture()]);

    await expect(
      recordLocalCodexBridgeEvents({
        bridge: bridgeFixture(),
        localCodexSessionId: "goat_local_codex_1",
        events: [{ method: "item/agentMessage/delta", params: { delta: "hello" } }],
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(mocks.insertBuilders[0]?.valuesValue).toMatchObject({
      userWorkosId: "user_1",
      localCodexSessionId: "goat_local_codex_1",
      localCodexTurnId: "goat_local_codex_turn_1",
      bridgeId: "goat_local_bridge_1",
    });
  });
});

function createUpdateBuilder() {
  const builder = {
    setValue: undefined as unknown,
    whereValue: undefined as unknown,
    returning: vi.fn(() => mocks.returningResults.shift() ?? []),
    set(value: unknown) {
      builder.setValue = value;
      return builder;
    },
    where(value: unknown) {
      builder.whereValue = value;
      return builder;
    },
  };
  return builder;
}

function createSelectBuilder() {
  const builder = {
    whereValue: undefined as unknown,
    from: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    where: vi.fn((value: unknown) => {
      builder.whereValue = value;
      return builder;
    }),
    limit: vi.fn(() => mocks.selectResults.shift() ?? []),
  };
  return builder;
}

function createInsertBuilder() {
  const builder = {
    valuesValue: undefined as unknown,
    values: vi.fn((value: unknown) => {
      builder.valuesValue = value;
      return undefined;
    }),
  };
  return builder;
}

function renderSql(value: unknown) {
  return pgDialect
    .sqlToQuery(value as SQL)
    .sql.replace(/\s+/g, " ")
    .trim();
}

function bridgeFixture(overrides: Partial<GoatLocalBridge> = {}): GoatLocalBridge {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "goat_local_bridge_1",
    userWorkosId: "user_1",
    name: "Local bridge",
    tokenHash: "token_hash",
    tokenPrefix: "oc_goat_local_test",
    lastSeenAt: now,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function commandFixture(overrides: Partial<GoatLocalCodexCommand> = {}): GoatLocalCodexCommand {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "goat_local_codex_cmd_1",
    userWorkosId: "user_1",
    localCodexSessionId: "goat_local_codex_1",
    localCodexTurnId: "goat_local_codex_turn_1",
    bridgeId: "goat_local_bridge_1",
    claimedByBridgeId: "goat_local_bridge_1",
    kind: "start_turn",
    status: "claimed",
    payload: {},
    error: null,
    claimedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function localSessionFixture(
  overrides: Partial<GoatLocalCodexSession> = {},
): GoatLocalCodexSession {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "goat_local_codex_1",
    userWorkosId: "user_1",
    chatSessionId: "goat_chat_1",
    bridgeId: "goat_local_bridge_1",
    repositoryPath: null,
    worktreePath: null,
    model: "gpt-5.5",
    codexThreadId: null,
    activeTurnId: "goat_local_codex_turn_1",
    status: "running",
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function localTurnFixture(overrides: Partial<GoatLocalCodexTurn> = {}): GoatLocalCodexTurn {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "goat_local_codex_turn_1",
    userWorkosId: "user_1",
    localCodexSessionId: "goat_local_codex_1",
    userMessageId: "goat_chat_msg_user_1",
    assistantMessageId: "goat_chat_msg_assistant_1",
    codexTurnId: null,
    status: "running",
    prompt: "Inspect",
    settings: {},
    error: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
