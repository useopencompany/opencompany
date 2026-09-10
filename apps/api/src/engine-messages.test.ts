import { describe, expect, it, vi } from "vitest";
import { admitEngineMessage } from "./engine-messages";

const connectedAuth = {
  getCodexStatus: vi.fn(async () => ({ status: "connected" as const })),
  getClaudeCodeStatus: vi.fn(async () => ({ status: "connected" as const })),
};

describe("engine message model admission", () => {
  it("admits Opus 5 and passes its CLI model name and effort to Claude Code", async () => {
    await expect(
      admitEngineMessage({
        actor: {} as never,
        engine: {
          type: "claude_code",
          schemaVersion: 1,
          settings: { reasoningEffort: "high" },
        },
        model: "anthropic/claude-opus-5",
        defaultProductModel: "moonshotai/kimi-k3",
        auth: connectedAuth as never,
      }),
    ).resolves.toEqual({
      engine: "claude_code",
      model: "anthropic/claude-opus-5",
      runtimeModel: "claude-opus-5",
      settings: { reasoningEffort: "high" },
    });
  });

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

  it("admits DeepSeek V4 Flash without changing the requested model", async () => {
    await expect(
      admitEngineMessage({
        actor: {} as never,
        engine: { type: "opencompany", schemaVersion: 1 },
        model: "deepseek/deepseek-v4-flash",
        defaultProductModel: "moonshotai/kimi-k3",
        auth: connectedAuth as never,
      }),
    ).resolves.toEqual({
      engine: "opencompany",
      model: "deepseek/deepseek-v4-flash",
      runtimeModel: "deepseek/deepseek-v4-flash",
    });
  });

  it.each([undefined, "openai/gpt-6-astra"])(
    "uses Astra for Codex with model %s",
    async (model) => {
      const admitted = await admitEngineMessage({
        actor: {} as never,
        engine: {
          type: "codex",
          schemaVersion: 1,
          settings: { reasoningEffort: "medium" },
        },
        ...(model ? { model } : {}),
        defaultProductModel: "moonshotai/kimi-k3",
        auth: connectedAuth as never,
      });

      expect(admitted).toMatchObject({
        engine: "codex",
        model: "openai/gpt-6-astra",
        runtimeModel: "gpt-6-astra",
      });
    },
  );
});
