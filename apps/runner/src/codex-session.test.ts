import { describe, expect, it } from "vitest";
import { buildCodexSessionCommandPlan, resumableCodexSessionId } from "./codex-session";

const auth = {
  kind: "api" as const,
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnvVar: "CODEX_API_KEY",
  apiKeyValue: "codex_secret_123",
  brokered: false,
};
const codexSessionHome = "/home/user/.opencompany-codex/session";

describe("buildCodexSessionCommandPlan", () => {
  it("runs Codex in the session work area without pre-cloning a repository", () => {
    const plan = buildCodexSessionCommandPlan({
      codexWorkRoot: "/home/user/workspace/codex",
      task: "implement the requested issue",
      model: "gpt-5.5",
      existingEngineSessionId: null,
      auth,
      githubAuth: { githubToken: null, githubAuthHeader: null },
    });

    expect(plan.codexWorkRoot).toBe("/home/user/workspace/codex");
    // CODEX_HOME lives outside the `--cd` work root so the workspace ChatGPT auth.json never sits
    // in the tree the model operates on.
    expect(plan.codexHome).toBe(codexSessionHome);
    expect(plan.codexHome.startsWith(`${plan.codexWorkRoot}/`)).toBe(false);
    expect(plan.codexHome.startsWith("/home/user/.opencompany/")).toBe(false);
    expect(plan.codexEnv).toMatchObject({
      CODEX_HOME: codexSessionHome,
      CODEX_API_KEY: "codex_secret_123",
    });
    expect(plan.command).toContain("cd '/home/user/workspace/codex'");
    expect(plan.command).toContain("--cd '/home/user/workspace/codex'");
    expect(plan.command).toContain("--skip-git-repo-check");
    expect(plan.command).toContain("codex exec --json");
    expect(plan.command).not.toContain("resume");
    expect(plan.command).not.toContain("git clone");
    expect(plan.command).not.toContain("codex_secret_123");
  });

  it("resumes an existing Codex CLI session when the engine session id is stored", () => {
    const plan = buildCodexSessionCommandPlan({
      codexWorkRoot: "/home/user/workspace/codex",
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
      codexWorkRoot: "/home/user/workspace/codex",
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
      codexWorkRoot: "/home/user/workspace/codex",
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
      codexWorkRoot: "/home/user/workspace/codex",
      task: "use workspace subscription",
      model: "gpt-5.5",
      existingEngineSessionId: null,
      auth: { kind: "chatgpt", authJson: { OPENAI_REFRESH_TOKEN: "secret" }, brokered: false },
      githubAuth: { githubToken: null, githubAuthHeader: null },
    });

    expect(plan.codexEnv).toEqual({
      CODEX_HOME: codexSessionHome,
    });
    expect(plan.codexHome).toBe(codexSessionHome);
    expect(plan.codexHome.startsWith(`${plan.codexWorkRoot}/`)).toBe(false);
    expect(plan.codexHome.startsWith("/home/user/.opencompany/")).toBe(false);
    expect(plan.config).toContain('cli_auth_credentials_store = "file"');
    expect(plan.config).toContain('forced_login_method = "chatgpt"');
    expect(plan.config).not.toContain("model_provider");
    expect(plan.config).not.toContain("env_key");
  });
});

describe("resumableCodexSessionId", () => {
  it("keeps a Codex session id from failed turns so retry messages can resume context", () => {
    expect(
      resumableCodexSessionId({
        sessionId: "019efe9c-a0a5-7f81-98a4-6fab601b4a76",
      }),
    ).toBe("019efe9c-a0a5-7f81-98a4-6fab601b4a76");
  });

  it("does not persist a missing Codex session id", () => {
    expect(resumableCodexSessionId({ sessionId: null })).toBeNull();
  });
});
