import { describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({
  opencompany: vi.fn(async () => "settled" as const),
  claude: vi.fn(async () => "settled" as const),
  codex: vi.fn(async () => "settled" as const),
}));

vi.mock("./opencompany-chat", () => ({ runProductChatTurn: runnerMocks.opencompany }));
vi.mock("./claude-code-chat", () => ({ runClaudeCodeChatTurn: runnerMocks.claude }));
vi.mock("./codex-chat", () => ({ runCodexChatTurn: runnerMocks.codex }));

import { CODING_ENGINE_REGISTRY, runCodingEngineTurn } from "./coding-engine-registry";

describe("CODING_ENGINE_REGISTRY", () => {
  it("contains one declarative runner entry for every coding engine", () => {
    expect(Object.keys(CODING_ENGINE_REGISTRY).sort()).toEqual([
      "claude_code",
      "codex",
      "opencompany",
    ]);
  });

  it.each([
    ["opencompany", runnerMocks.opencompany],
    ["claude_code", runnerMocks.claude],
    ["codex", runnerMocks.codex],
  ] as const)("dispatches %s without worker branching", async (engine, runner) => {
    const input = { session: { engine } } as Parameters<typeof runCodingEngineTurn>[0];

    await expect(runCodingEngineTurn(input)).resolves.toBe("settled");

    expect(runner).toHaveBeenCalledWith(input);
  });
});
