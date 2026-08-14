import { describe, expect, it } from "vitest";
import { validateClaudeCodeToken } from "./claude-code-token";

describe("validateClaudeCodeToken", () => {
  it("normalizes a plausible setup token", () => {
    const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

    expect(validateClaudeCodeToken(`  ${token}\n`)).toEqual({ ok: true, token });
  });

  it("rejects a prefix-only placeholder", () => {
    expect(validateClaudeCodeToken("sk-ant-oat")).toEqual({
      ok: false,
      error: "That doesn't look like a valid Claude Code token.",
    });
  });

  it("normalizes tokens copied from wrapped terminal output", () => {
    const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

    expect(validateClaudeCodeToken("sk-ant-oat01-abcdefghij \r\n\tklmnopqrstuvwxyz")).toEqual({
      ok: true,
      token,
    });
  });

  it("rejects other credential formats", () => {
    expect(validateClaudeCodeToken("sk-ant-api03-abcdefghijklmnopqrstuvwxyz").ok).toBe(false);
  });
});
