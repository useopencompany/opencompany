import { describe, expect, it } from "vitest";
import { buildCodexSessionCommandPlan } from "./codex-session";

const auth = {
  kind: "api" as const,
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnvVar: "CODEX_API_KEY",
  apiKeyValue: "codex_secret_123",
  brokered: false,
};

describe("buildCodexSessionCommandPlan", () => {
  it("runs Codex in the session work area without pre-cloning a repository", () => {
    const plan = buildCodexSessionCommandPlan({
      workRoot: "/home/user/workspace/work",
      task: "implement the requested issue",
      model: "gpt-5.5",
      existingEngineSessionId: null,
      auth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
    });

    expect(plan.codexWorkRoot).toBe("/home/user/workspace/work/codex");
    expect(plan.codexHome).toBe("/home/user/workspace/work/codex/.codex");
    expect(plan.codexEnv).toMatchObject({
      CODEX_HOME: "/home/user/workspace/work/codex/.codex",
      CODEX_API_KEY: "codex_secret_123",
    });
    expect(plan.command).toContain("cd '/home/user/workspace/work/codex'");
    expect(plan.command).toContain("--cd '/home/user/workspace/work/codex'");
    expect(plan.command).toContain("--skip-git-repo-check");
    expect(plan.command).toContain("codex exec --json");
    expect(plan.command).not.toContain("resume");
    expect(plan.command).not.toContain("git clone");
    expect(plan.command).not.toContain("codex_secret_123");
  });

  it("resumes an existing Codex CLI session when the engine session id is stored", () => {
    const plan = buildCodexSessionCommandPlan({
      workRoot: "/home/user/workspace/work",
      task: "continue the prior work",
      model: "gpt-5.5",
      existingEngineSessionId: "codex-session-123",
      auth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
    });

    expect(plan.command).toContain(
      "resume -m 'gpt-5.5' 'codex-session-123' 'continue the prior work'",
    );
  });

  it("passes Codex reasoning config overrides", () => {
    const plan = buildCodexSessionCommandPlan({
      workRoot: "/home/user/workspace/work",
      task: "reason carefully",
      model: "gpt-5.5",
      reasoningEffort: "high",
      planModeReasoningEffort: "xhigh",
      existingEngineSessionId: null,
      auth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
    });

    expect(plan.command).toContain("-m 'gpt-5.5'");
    expect(plan.command).toContain("-c 'model_reasoning_effort=high'");
    expect(plan.command).toContain("-c 'plan_mode_reasoning_effort=xhigh'");
  });

  it("passes GitHub auth without setting a default repository", () => {
    const plan = buildCodexSessionCommandPlan({
      workRoot: "/home/user/workspace/work",
      task: "clone the right repo if needed",
      model: "gpt-5.5",
      existingEngineSessionId: null,
      auth,
      githubAuth: {
        githubToken: "github_token_123",
        githubAuthHeader: "Authorization: Basic github_basic_secret",
      },
    });

    expect(plan.codexEnv).toMatchObject({
      GH_TOKEN: "github_token_123",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_CONFIG_DIR: "/tmp/opencompany-gh-codex-session",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic github_basic_secret",
    });
    expect(plan.codexEnv).not.toHaveProperty("GH_REPO");
    expect(plan.command).not.toContain("github_token_123");
    expect(plan.command).not.toContain("github_basic_secret");
  });

  it("uses saved ChatGPT auth without API key environment variables", () => {
    const plan = buildCodexSessionCommandPlan({
      workRoot: "/home/user/workspace/work",
      task: "use workspace subscription",
      model: "gpt-5.5",
      existingEngineSessionId: null,
      auth: { kind: "chatgpt", authJson: { OPENAI_REFRESH_TOKEN: "secret" }, brokered: false },
      githubAuth: { githubToken: null, githubAuthHeader: null },
    });

    expect(plan.codexEnv).toEqual({
      CODEX_HOME: "/home/user/workspace/work/codex/.codex",
    });
    expect(plan.config).toContain('cli_auth_credentials_store = "file"');
    expect(plan.config).toContain('forced_login_method = "chatgpt"');
    expect(plan.config).not.toContain("model_provider");
    expect(plan.config).not.toContain("env_key");
  });
});
