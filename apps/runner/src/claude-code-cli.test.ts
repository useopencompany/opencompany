import { describe, expect, it } from "vitest";
import { buildClaudeCommandEnv, buildClaudeTurnCommand } from "./claude-code-cli";

const auth = {
  kind: "oauth" as const,
  token: "sk-ant-oat01-test-token",
  subscriptionType: null,
  rateLimitTier: null,
};

describe("buildClaudeCommandEnv", () => {
  it("sets only the subscription token by default", () => {
    expect(buildClaudeCommandEnv({ auth })).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-token",
    });
  });

  it("includes subscription-type hints when stored with the credential", () => {
    const env = buildClaudeCommandEnv({
      auth: { ...auth, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" },
    });
    expect(env.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe("max");
    expect(env.CLAUDE_CODE_RATE_LIMIT_TIER).toBe("default_claude_max_20x");
  });

  // In -p mode an API key silently outranks the subscription token and flips the
  // session to metered API billing — it must never reach the command env.
  it("strips API-key credentials even if a caller leaks them through githubEnv", () => {
    const env = buildClaudeCommandEnv({
      auth,
      githubEnv: {
        GH_TOKEN: "gh-token",
        ANTHROPIC_API_KEY: "leaked",
        ANTHROPIC_AUTH_TOKEN: "leaked",
      },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBe("gh-token");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test-token");
  });
});

describe("buildClaudeTurnCommand", () => {
  it("builds a stream-json headless invocation that unsets API keys", () => {
    const command = buildClaudeTurnCommand({
      workdir: "/home/user/opencompany-goat/claude-chat",
      promptPath: "/home/user/.opencompany-goat/claude-chat-prompts/prompt-t1.txt",
      model: "claude-sonnet-5",
      reasoningEffort: "xhigh",
      resumeSessionId: "sess-1",
    });
    expect(command).toContain("unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--verbose");
    expect(command).toContain("--permission-mode bypassPermissions");
    expect(command).toContain("--model 'claude-sonnet-5'");
    expect(command).toContain("--effort 'xhigh'");
    expect(command).toContain("--resume 'sess-1'");
    expect(command).not.toContain("--bare");
  });

  it("omits resume and model when not provided", () => {
    const command = buildClaudeTurnCommand({
      workdir: "/w",
      promptPath: "/p",
      model: null,
      reasoningEffort: null,
      resumeSessionId: null,
    });
    expect(command).not.toContain("--resume");
    expect(command).not.toContain("--model");
    expect(command).not.toContain("--effort");
  });
});
