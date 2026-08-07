import type { CodexChatTurn } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_CHAT_WAKEUP_MAX_CHAIN,
  enqueueCodexChatWakeup,
  persistCodexChatScheduledWakeup,
  scheduledWakeupFromTurnSettings,
} from "./codex-chat-wakeup";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

describe("enqueueCodexChatWakeup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ rows: [{ id: "goat_codex_chat_turn_wakeup" }] });
  });

  it("enqueues both synthetic messages and a delayed turn without activating the session", async () => {
    const result = await enqueueCodexChatWakeup({
      parentTurn: parentTurn(),
      model: "claude-opus-4-8",
      wakeup: {
        delaySeconds: 120,
        reason: "Wait for CI",
        prompt: "Inspect PR #42.",
      },
      now: new Date("2026-07-10T09:00:00.000Z"),
    });

    expect(result).toBe("enqueued");
    const statement = sqlText(mocks.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("inserted_user_message AS");
    expect(statement).toContain("inserted_assistant_message AS");
    expect(statement).toContain("inserted_turn AS");
    expect(statement).toContain("run_after");
    expect(statement).toContain("sibling.created_at > parent.created_at");
    expect(statement).toContain("engine_session.status = 'idle'");
    expect(statement).toContain("chat_session.kind = 'chat'");
    expect(statement).toContain("chat_session.closed_at IS NULL");
    expect(statement).toContain("FOR UPDATE OF engine_session, chat_session");
    expect(statement).not.toContain("UPDATE goat.codex_chat_sessions");
    const queryChunks = (mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] })
      .queryChunks;
    const serialized = JSON.stringify(queryChunks);
    expect(serialized).toContain("Automated scheduled wakeup");
    expect(queryChunks).toContain('{"wakeupChain":1}');
    expect(serialized).toContain("2026-07-10T09:02:00.000Z");
  });

  it("does not carry the parent's persisted wakeup request into the child turn", async () => {
    await enqueueCodexChatWakeup({
      parentTurn: parentTurn({
        settings: {
          reasoningEffort: "high",
          wakeupChain: 1,
          scheduledWakeup: {
            delaySeconds: 60,
            reason: "Old request",
            prompt: "Do not replay this.",
          },
        },
      }),
      model: "claude-opus-4-8",
      wakeup: { delaySeconds: 60, reason: "Current request", prompt: "" },
    });

    const queryChunks = (mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] })
      .queryChunks;
    expect(queryChunks).toContain('{"reasoningEffort":"high","wakeupChain":2}');
    expect(queryChunks).not.toContain(
      '{"reasoningEffort":"high","wakeupChain":1,"scheduledWakeup":{"delaySeconds":60,"reason":"Old request","prompt":"Do not replay this."}}',
    );
  });

  it("refuses to create a wakeup when a newer queued or running turn supersedes it", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await expect(
      enqueueCodexChatWakeup({
        parentTurn: parentTurn(),
        model: "claude-opus-4-8",
        wakeup: { delaySeconds: 60, reason: "Wait for CI", prompt: "" },
      }),
    ).resolves.toBe("superseded");

    expect(sqlText(mocks.execute.mock.calls[0]?.[0])).toContain(
      "sibling.status IN ('queued', 'running')",
    );
  });

  it("caps recursive wakeup chains before writing anything", async () => {
    await expect(
      enqueueCodexChatWakeup({
        parentTurn: parentTurn({
          settings: { wakeupChain: CODEX_CHAT_WAKEUP_MAX_CHAIN },
        }),
        model: "claude-opus-4-8",
        wakeup: { delaySeconds: 60, reason: "Wait for CI", prompt: "" },
      }),
    ).resolves.toBe("chain_capped");

    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("persists a scheduled wakeup only while the worker still owns the running turn", async () => {
    await persistCodexChatScheduledWakeup({
      turnId: "goat_codex_chat_turn_1",
      userWorkosId: "user_1",
      codexChatSessionId: "goat_codex_chat_1",
      leaseId: "lease_1",
      leaseOwner: "runner_1",
      wakeup: { delaySeconds: 120, reason: "Wait for CI", prompt: "Inspect PR #42." },
      now: new Date("2026-07-10T09:00:00.000Z"),
    });

    const statement = sqlText(mocks.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("jsonb_set");
    expect(statement).toContain("lease_id =");
    expect(statement).toContain("lease_owner =");
    expect(statement).toContain("status = 'running'");
    const queryChunks = (mocks.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] })
      .queryChunks;
    expect(queryChunks).toContain(
      '{"delaySeconds":120,"reason":"Wait for CI","prompt":"Inspect PR #42."}',
    );
  });

  it("fails persistence after the turn lease is lost", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await expect(
      persistCodexChatScheduledWakeup({
        turnId: "goat_codex_chat_turn_1",
        userWorkosId: "user_1",
        codexChatSessionId: "goat_codex_chat_1",
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        wakeup: { delaySeconds: 120, reason: "Wait for CI", prompt: "" },
      }),
    ).rejects.toMatchObject({ name: "CodexChatLeaseLostError" });
  });

  it("restores and validates the last persisted wakeup during recovery", () => {
    expect(
      scheduledWakeupFromTurnSettings({
        scheduledWakeup: {
          delaySeconds: 5,
          reason: "  Wait for CI  ",
          prompt: "  Inspect the run.  ",
        },
      }),
    ).toEqual({
      delaySeconds: 60,
      reason: "Wait for CI",
      prompt: "Inspect the run.",
    });
    expect(
      scheduledWakeupFromTurnSettings({
        scheduledWakeup: { delaySeconds: Number.NaN, reason: "Wait", prompt: "" },
      }),
    ).toBeNull();
  });
});

function parentTurn(overrides: Partial<CodexChatTurn> = {}) {
  return {
    id: "goat_codex_chat_turn_parent",
    userWorkosId: "user_1",
    codexChatSessionId: "goat_codex_chat_1",
    chatSessionId: "goat_chat_1",
    createdAt: new Date("2026-07-10T08:59:00.000Z"),
    settings: {},
    ...overrides,
  };
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value?: unknown }).value;
        return Array.isArray(value) ? value.join("") : String(value ?? "");
      }
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) return sqlText(chunk);
      return "";
    })
    .join("");
}
