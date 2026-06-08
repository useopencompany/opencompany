import { describe, expect, it } from "vitest";
import {
  MEMORY_KEEPER_RUNTIME_TOOLS,
  MEMORY_KEEPER_SYSTEM_PROMPT,
  restrictToolsForMemoryKeeper,
} from "./memory-keeper";
import type { RuntimeToolName } from "./tools";

describe("restrictToolsForMemoryKeeper", () => {
  it("keeps only the memory-keeper allowlist and drops everything else", () => {
    const input: RuntimeToolName[] = [
      "memory",
      "recall",
      "fetch_transcript",
      "read_file",
      "write_file",
      "edit_file",
      "list_files",
      "read_skill",
      "shell",
      "gh",
      "delegate_to_agent",
      "ask_user_question",
      "opencode_coder",
      "exa_search",
    ];

    const restricted = restrictToolsForMemoryKeeper(input);

    for (const tool of restricted) {
      expect(MEMORY_KEEPER_RUNTIME_TOOLS.has(tool)).toBe(true);
    }
    expect(restricted).toContain("memory");
    expect(restricted).toContain("recall");
    expect(restricted).toContain("fetch_transcript");
    expect(restricted).not.toContain("delegate_to_agent");
    expect(restricted).not.toContain("ask_user_question");
    expect(restricted).not.toContain("opencode_coder");
    expect(restricted).not.toContain("exa_search");
    expect(restricted).not.toContain("shell");
  });

  it("preserves the order of the input tools", () => {
    expect(restrictToolsForMemoryKeeper(["recall", "memory", "edit_file"])).toEqual([
      "recall",
      "memory",
      "edit_file",
    ]);
  });
});

describe("MEMORY_KEEPER_SYSTEM_PROMPT", () => {
  it("instructs the keeper on the core memory discipline", () => {
    expect(MEMORY_KEEPER_SYSTEM_PROMPT).toContain("fetch_transcript");
    expect(MEMORY_KEEPER_SYSTEM_PROMPT).toContain("agent/user.md");
    expect(MEMORY_KEEPER_SYSTEM_PROMPT).toContain("agent/memory.md");
    // Defaults to a no-op so trivial sessions cost nothing meaningful.
    expect(MEMORY_KEEPER_SYSTEM_PROMPT).toMatch(/NO update|nothing durable|do nothing/i);
    // Corrections are prioritized.
    expect(MEMORY_KEEPER_SYSTEM_PROMPT).toMatch(/correct/i);
  });
});
