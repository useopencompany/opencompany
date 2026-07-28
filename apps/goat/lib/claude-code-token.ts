export type ValidatedGoatClaudeCodeToken =
  | { ok: true; token: string }
  | { ok: false; error: string };

// Long-lived OAuth tokens from `claude setup-token` are prefixed sk-ant-oat.
const CLAUDE_CODE_TOKEN_PREFIX = "sk-ant-oat";
const CLAUDE_CODE_TOKEN_MIN_LENGTH = 32;
const CLAUDE_CODE_TOKEN_MAX_LENGTH = 512;

export function validateGoatClaudeCodeToken(value: string): ValidatedGoatClaudeCodeToken {
  const token = value.trim();
  if (!token) {
    return { ok: false, error: "Paste the token printed by `claude setup-token`." };
  }
  if (!token.startsWith(CLAUDE_CODE_TOKEN_PREFIX)) {
    return {
      ok: false,
      error: "That doesn't look like a Claude Code token (expected it to start with sk-ant-oat).",
    };
  }
  if (
    token.length < CLAUDE_CODE_TOKEN_MIN_LENGTH ||
    token.length > CLAUDE_CODE_TOKEN_MAX_LENGTH ||
    /\s/.test(token)
  ) {
    return { ok: false, error: "That doesn't look like a valid Claude Code token." };
  }
  return { ok: true, token };
}
