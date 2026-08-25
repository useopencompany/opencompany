import { describe, expect, it } from "vitest";
import {
  buildClaudeAcpCommand,
  buildClaudeAcpCommandEnv,
  buildClaudeCommandEnv,
  KILL_LEFTOVER_CLAUDE_TURN_COMMAND,
} from "./claude-code-cli";

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

describe("buildClaudeAcpCommandEnv", () => {
  it("keeps OAuth auth isolated while selecting the configured model", () => {
    expect(
      buildClaudeAcpCommandEnv({
        auth,
        githubEnv: { GH_TOKEN: "gh-token", ANTHROPIC_API_KEY: "leaked" },
        model: "claude-sonnet-5",
      }),
    ).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-token",
      GH_TOKEN: "gh-token",
      ANTHROPIC_MODEL: "claude-sonnet-5",
    });
  });
});

describe("buildClaudeAcpCommand", () => {
  it("runs the pinned adapter over stdio from the chat workdir", () => {
    const command = buildClaudeAcpCommand("/home/user/opencompany-goat/claude-chat");
    expect(command).toContain("cd '/home/user/opencompany-goat/claude-chat'");
    expect(command).toContain("unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN");
    expect(command).toContain('export PATH="$HOME/.claude-cli/bin":"$PATH"');
    expect(command).toContain("exec claude-agent-acp");
  });
});

describe("KILL_LEFTOVER_CLAUDE_TURN_COMMAND", () => {
  it("matches an ACP adapter process but not its own command line", () => {
    const pattern = /'(.+)'/.exec(KILL_LEFTOVER_CLAUDE_TURN_COMMAND)?.[1];
    expect(pattern).toBeTruthy();
    const regex = new RegExp(pattern as string);
    expect(regex.test(buildClaudeAcpCommand("/work"))).toBe(true);
    expect(regex.test(KILL_LEFTOVER_CLAUDE_TURN_COMMAND)).toBe(false);
  });

  it("tolerates no matching process", () => {
    expect(KILL_LEFTOVER_CLAUDE_TURN_COMMAND).toMatch(/\|\| true$/);
  });
});
