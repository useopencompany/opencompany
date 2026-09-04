import { describe, expect, it, vi } from "vitest";
import { admitEngineMessage } from "./engine-messages";

const connectedAuth = {
  getCodexStatus: vi.fn(async () => ({ status: "connected" as const })),
  getClaudeCodeStatus: vi.fn(async () => ({ status: "connected" as const })),
};

describe("engine message model admission", () => {
  it("normalizes rollout-gated opencompany sessions to the safe replacement", async () => {
    await expect(
      admitEngineMessage({
        actor: {} as never,
        engine: { type: "opencompany", schemaVersion: 1 },
        model: "openai/gpt-6-astra",
        defaultProductModel: "moonshotai/kimi-k3",
        auth: connectedAuth as never,
      }),
    ).resolves.toEqual({
      engine: "opencompany",
      model: "openai/gpt-5.6-sol",
      runtimeModel: "openai/gpt-5.6-sol",
    });
  });

  it("keeps a persisted Codex session runnable through the safe replacement", async () => {
    const admitted = await admitEngineMessage({
      actor: {} as never,
      engine: {
        type: "codex",
        schemaVersion: 1,
        settings: { reasoningEffort: "medium" },
      },
      model: "openai/gpt-6-astra",
      defaultProductModel: "moonshotai/kimi-k3",
      auth: connectedAuth as never,
    });

    expect(admitted).toMatchObject({
      engine: "codex",
      model: "openai/gpt-5.6-sol",
      runtimeModel: "gpt-5.6-sol",
    });
  });
});
