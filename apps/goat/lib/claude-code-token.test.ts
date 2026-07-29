import { describe, expect, it } from "vitest";
import { validateGoatClaudeCodeToken } from "./claude-code-token";

describe("validateGoatClaudeCodeToken", () => {
  it("normalizes a plausible setup token", () => {
    const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

    expect(validateGoatClaudeCodeToken(`  ${token}\n`)).toEqual({ ok: true, token });
  });

  it("rejects a prefix-only placeholder", () => {
    expect(validateGoatClaudeCodeToken("sk-ant-oat")).toEqual({
      ok: false,
      error: "That doesn't look like a valid Claude Code token.",
    });
  });

  it("normalizes tokens copied from wrapped terminal output", () => {
    const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

    expect(validateGoatClaudeCodeToken("sk-ant-oat01-abcdefghij \r\n\tklmnopqrstuvwxyz")).toEqual({
      ok: true,
      token,
    });
  });

  it("rejects other credential formats", () => {
    expect(validateGoatClaudeCodeToken("sk-ant-api03-abcdefghijklmnopqrstuvwxyz").ok).toBe(false);
  });
});
