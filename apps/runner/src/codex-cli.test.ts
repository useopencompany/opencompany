import { describe, expect, it, vi } from "vitest";
import {
  buildCodexConfig,
  buildCodexConfigForAuth,
  CODEX_FALLBACK_NPM_PACKAGE,
  ensureCodexInstalled,
} from "./codex-cli";

describe("ensureCodexInstalled", () => {
  it("keeps the expected Codex CLI version", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "codex-cli 0.144.6\n" });

    await ensureCodexInstalled({ commands: { run } } as never);

    expect(CODEX_FALLBACK_NPM_PACKAGE).toBe("@openai/codex@0.144.6");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toContain("codex --version");
  });

  it("replaces a mismatched Codex CLI in the active home prefix", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "codex-cli 0.144.5\n" })
      .mockResolvedValueOnce({ stdout: "" });

    await ensureCodexInstalled({ commands: { run } } as never);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain('npm install -g --prefix "$HOME/.codex"');
    expect(run.mock.calls[1]?.[0]).toContain("@openai/codex@0.144.6");
    expect(run.mock.calls[1]?.[0]).toContain("codex-cli 0.144.6");
  });
});

describe("buildCodexConfig", () => {
  it("configures Codex to use the opencompany Responses provider", () => {
    const config = buildCodexConfig({
      baseUrl: "https://runner.example.com/broker/openai/v1",
      apiKeyEnvVar: "LLM_BROKER_TOKEN",
    });

    expect(config).toContain('model_provider = "opencompany"');
    expect(config).toContain('model_verbosity = "medium"');
    expect(config).toContain("[features]");
    expect(config).toContain("goals = true");
    expect(config).toContain("[sandbox_workspace_write]");
    expect(config).toContain("network_access = true");
    expect(config).toContain("[model_providers.opencompany]");
    expect(config).toContain('name = "opencompany"');
    expect(config).toContain('base_url = "https://runner.example.com/broker/openai/v1"');
    expect(config).toContain('env_key = "LLM_BROKER_TOKEN"');
    expect(config).toContain('wire_api = "responses"');
  });

  it("configures Codex to use file-backed ChatGPT auth for subscription-backed runs", () => {
    const config = buildCodexConfigForAuth({
      kind: "chatgpt",
      authJson: { OPENAI_REFRESH_TOKEN: "secret" },
      credentialLastRotatedAt: null,
      brokered: false,
    });

    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('forced_login_method = "chatgpt"');
    expect(config).toContain("[features]");
    expect(config).toContain("goals = true");
    expect(config).toContain("[sandbox_workspace_write]");
    expect(config).toContain("network_access = true");
    expect(config).not.toContain("model_provider");
    expect(config).not.toContain("env_key");
  });
});
