import { describe, expect, it, vi } from "vitest";
import {
  buildCodexAcpCommand,
  buildCodexAcpCommandEnv,
  buildCodexConfig,
  buildCodexConfigForAuth,
  buildCodexJsonConfigForAuth,
  CODEX_FALLBACK_NPM_PACKAGE,
  ensureCodexAcpAdapterInstalled,
  ensureCodexInstalled,
  KILL_LEFTOVER_CODEX_TURN_COMMAND,
  killLeftoverCodexTurnProcesses,
} from "./codex-cli";

describe("ensureCodexInstalled", () => {
  it("keeps the expected Codex CLI version", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "codex-cli 0.148.0\n" });

    await ensureCodexInstalled({ commands: { run } } as never);

    expect(CODEX_FALLBACK_NPM_PACKAGE).toBe("@openai/codex@0.148.0");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toContain("codex --version");
    expect(run.mock.calls[0]?.[1]).toEqual({ timeoutMs: 60_000 });
  });

  it("replaces a mismatched Codex CLI in the active home prefix", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "codex-cli 0.147.0\n" })
      .mockResolvedValueOnce({ stdout: "" });

    await ensureCodexInstalled({ commands: { run } } as never);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain('npm install -g --prefix "$HOME/.codex"');
    expect(run.mock.calls[1]?.[0]).toContain("@openai/codex@0.148.0");
    expect(run.mock.calls[1]?.[0]).toContain("codex-cli 0.148.0");
  });
});

describe("ensureCodexAcpAdapterInstalled", () => {
  it("accepts only the exact adapter and bundled Codex versions", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: "@agentclientprotocol/codex-acp 1.6.0\ncodex-cli 0.148.0\n",
    });

    await ensureCodexAcpAdapterInstalled({ commands: { run } } as never);

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toEqual({ timeoutMs: 60_000 });
  });

  it("installs and verifies both exact versions when either one drifts", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "@agentclientprotocol/codex-acp 1.5.0\ncodex-cli 0.148.0\n",
      })
      .mockResolvedValueOnce({ stdout: "" });

    await ensureCodexAcpAdapterInstalled({ commands: { run } } as never);

    expect(run.mock.calls[1]?.[0]).toContain("@agentclientprotocol/codex-acp@1.6.0");
    expect(run.mock.calls[1]?.[0]).toContain("@openai/codex@0.148.0");
    expect(run.mock.calls[1]?.[0]).toContain(
      "test \"$(codex-acp --version)\" = '@agentclientprotocol/codex-acp 1.6.0'",
    );
    expect(run.mock.calls[1]?.[0]).toContain("test \"$(codex --version)\" = 'codex-cli 0.148.0'");
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

describe("buildCodexAcpCommandEnv", () => {
  it("configures API-key authentication without exposing it in CODEX_CONFIG", () => {
    const auth = {
      kind: "api" as const,
      baseUrl: "https://runner.example.com/broker/openai/v1",
      apiKeyEnvVar: "LLM_BROKER_TOKEN",
      apiKeyValue: "secret",
      brokered: true,
    };

    const commandEnv = buildCodexAcpCommandEnv({
      auth,
      codexHome: "/home/user/.codex-home",
      mcpServers: [],
      toolTimeoutMs: 10_800_000,
    });

    expect(commandEnv).toMatchObject({
      CODEX_HOME: "/home/user/.codex-home",
      LLM_BROKER_TOKEN: "secret",
      MODEL_PROVIDER: "opencompany",
      INITIAL_AGENT_MODE: "agent-full-access",
    });
    expect(commandEnv.CODEX_CONFIG).not.toContain("secret");
    expect(buildCodexJsonConfigForAuth(auth)).toMatchObject({
      model_provider: "opencompany",
      model_providers: {
        opencompany: {
          base_url: "https://runner.example.com/broker/openai/v1",
          env_key: "LLM_BROKER_TOKEN",
          wire_api: "responses",
        },
      },
    });
  });

  it("sets the ACP gateway timeout in Codex's mcp_servers config", () => {
    const config = buildCodexJsonConfigForAuth(
      {
        kind: "chatgpt",
        authJson: {},
        credentialLastRotatedAt: null,
        brokered: false,
      },
      {
        mcpServers: [
          {
            name: "opencompany",
            type: "http",
            url: "https://runner.example.com/internal/goat/acp-tools",
            headers: [{ name: "x-opencompany-tool-ticket", value: "gateway-ticket" }],
          },
        ],
        toolTimeoutMs: 10_800_000,
      },
    );

    expect(config).toMatchObject({
      mcp_servers: {
        opencompany: {
          url: "https://runner.example.com/internal/goat/acp-tools",
          http_headers: { "x-opencompany-tool-ticket": "gateway-ticket" },
          tool_timeout_sec: 10_800,
        },
      },
    });
  });

  it("selects file-backed ChatGPT authentication", () => {
    expect(
      buildCodexJsonConfigForAuth({
        kind: "chatgpt",
        authJson: { tokens: { access_token: "secret" } },
        credentialLastRotatedAt: null,
        brokered: false,
      }),
    ).toMatchObject({
      cli_auth_credentials_store: "file",
      forced_login_method: "chatgpt",
    });
  });
});

describe("KILL_LEFTOVER_CODEX_TURN_COMMAND", () => {
  it("matches a codex/codex-acp process but not its own command line", () => {
    const pattern = /'(.+)'/.exec(KILL_LEFTOVER_CODEX_TURN_COMMAND)?.[1];
    expect(pattern).toBeTruthy();
    const regex = new RegExp(pattern as string);
    expect(regex.test(buildCodexAcpCommand("/work"))).toBe(true);
    expect(regex.test(KILL_LEFTOVER_CODEX_TURN_COMMAND)).toBe(false);
  });

  it("tolerates no matching process", () => {
    expect(KILL_LEFTOVER_CODEX_TURN_COMMAND).toMatch(/\|\| true$/);
  });
});

describe("killLeftoverCodexTurnProcesses", () => {
  it("runs the fence command in the sandbox", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 });

    await killLeftoverCodexTurnProcesses({ commands: { run } } as never);

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe(KILL_LEFTOVER_CODEX_TURN_COMMAND);
  });
});
