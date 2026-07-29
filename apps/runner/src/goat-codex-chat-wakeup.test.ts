import type { GoatCodexChatTurn } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueGoatCodexChatWakeup,
  GOAT_CODEX_CHAT_WAKEUP_MAX_CHAIN,
} from "./goat-codex-chat-wakeup";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

describe("enqueueGoatCodexChatWakeup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ rows: [{ id: "goat_codex_chat_turn_wakeup" }] });
  });

  it("enqueues both synthetic messages and a delayed turn without activating the session", async () => {
    const result = await enqueueGoatCodexChatWakeup({
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

  it("refuses to create a wakeup when a newer queued or running turn supersedes it", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await expect(
      enqueueGoatCodexChatWakeup({
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
      enqueueGoatCodexChatWakeup({
        parentTurn: parentTurn({
          settings: { wakeupChain: GOAT_CODEX_CHAT_WAKEUP_MAX_CHAIN },
        }),
        model: "claude-opus-4-8",
        wakeup: { delaySeconds: 60, reason: "Wait for CI", prompt: "" },
      }),
    ).resolves.toBe("chain_capped");

    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

function parentTurn(overrides: Partial<GoatCodexChatTurn> = {}) {
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
