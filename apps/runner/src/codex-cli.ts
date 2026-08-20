import { shellQuote } from "@opencompany/agent-runtime";
import {
  CODEX_ACP_ADAPTER_PACKAGE,
  CODEX_ACP_ADAPTER_VERSION_OUTPUT,
  CODEX_CLI_PACKAGE,
  CODEX_CLI_VERSION_OUTPUT,
} from "./codex-version";
import type { SandboxHandle } from "./sandbox";

const CODEX_BIN_PATH = '"$HOME/.codex/bin"';
const CODEX_ACP_PREFIX = '"$HOME/.codex-acp"';
const CODEX_ACP_BIN_PATH = '"$HOME/.codex-acp/bin"';
export const CODEX_FALLBACK_NPM_PACKAGE = CODEX_CLI_PACKAGE;
const CODEX_PROVIDER_ID = "opencompany";
const CODEX_PROVIDER_NAME = "opencompany";

export type CodexCliAuth =
  | {
      kind: "api";
      baseUrl: string;
      apiKeyEnvVar: string;
      apiKeyValue: string;
      brokered: boolean;
    }
  | {
      kind: "chatgpt";
      authJson: Record<string, unknown>;
      credentialLastRotatedAt: Date | null;
      brokered: false;
    };

export async function ensureCodexInstalled(sandbox: SandboxHandle) {
  const check = await sandbox.commands.run(
    `export PATH=${CODEX_BIN_PATH}:"$PATH" && codex --version 2>/dev/null || true`,
    { timeoutMs: 30_000 },
  );
  if (String(check.stdout ?? "").trim() === CODEX_CLI_VERSION_OUTPUT) return;
  await sandbox.commands.run(
    [
      `npm install -g --prefix "$HOME/.codex" ${shellQuote(CODEX_FALLBACK_NPM_PACKAGE)}`,
      `export PATH=${CODEX_BIN_PATH}:"$PATH"`,
      `test "$(codex --version)" = ${shellQuote(CODEX_CLI_VERSION_OUTPUT)}`,
    ].join(" && "),
    { timeoutMs: 180_000 },
  );
}

export async function ensureCodexAcpAdapterInstalled(sandbox: SandboxHandle) {
  const check = await sandbox.commands.run(
    [
      `export PATH=${CODEX_ACP_BIN_PATH}:${CODEX_BIN_PATH}:"$PATH"`,
      "codex-acp --version 2>/dev/null || true",
      "codex --version 2>/dev/null || true",
    ].join(" && "),
    { timeoutMs: 30_000 },
  );
  const output = String(check.stdout ?? "");
  if (
    output.includes(CODEX_ACP_ADAPTER_VERSION_OUTPUT) &&
    output.includes(CODEX_CLI_VERSION_OUTPUT)
  ) {
    return;
  }
  await sandbox.commands.run(
    [
      `npm install -g --prefix ${CODEX_ACP_PREFIX} ${shellQuote(CODEX_ACP_ADAPTER_PACKAGE)} ${shellQuote(CODEX_CLI_PACKAGE)}`,
      `export PATH=${CODEX_ACP_BIN_PATH}:"$PATH"`,
      `test "$(codex-acp --version)" = ${shellQuote(CODEX_ACP_ADAPTER_VERSION_OUTPUT)}`,
      `test "$(codex --version)" = ${shellQuote(CODEX_CLI_VERSION_OUTPUT)}`,
    ].join(" && "),
    { timeoutMs: 180_000 },
  );
}

export function buildCodexAcpCommand(workdir: string) {
  return [
    `cd ${shellQuote(workdir)}`,
    `export PATH=${CODEX_ACP_BIN_PATH}:${CODEX_BIN_PATH}:"$PATH"`,
    "exec codex-acp",
  ].join(" && ");
}

export function buildCodexAcpCommandEnv(input: {
  auth: CodexCliAuth;
  codexHome: string;
  githubEnv?: Record<string, string>;
}) {
  const config = buildCodexJsonConfigForAuth(input.auth);
  return {
    ...(input.githubEnv ?? {}),
    CODEX_HOME: input.codexHome,
    CODEX_CONFIG: JSON.stringify(config),
    NO_BROWSER: "1",
    INITIAL_AGENT_MODE: "agent-full-access",
    ...(input.auth.kind === "api"
      ? {
          [input.auth.apiKeyEnvVar]: input.auth.apiKeyValue,
          MODEL_PROVIDER: CODEX_PROVIDER_ID,
        }
      : {}),
  };
}

export function buildCodexConfig(input: { baseUrl: string; apiKeyEnvVar: string }) {
  return [
    `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
    `model_verbosity = "medium"`,
    "",
    "[features]",
    "goals = true",
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    `name = ${tomlString(CODEX_PROVIDER_NAME)}`,
    `base_url = ${tomlString(input.baseUrl)}`,
    `env_key = ${tomlString(input.apiKeyEnvVar)}`,
    `wire_api = "responses"`,
    "",
  ].join("\n");
}

export function buildCodexSubscriptionConfig() {
  return [
    'cli_auth_credentials_store = "file"',
    'forced_login_method = "chatgpt"',
    `model_verbosity = "medium"`,
    "",
    "[features]",
    "goals = true",
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
  ].join("\n");
}

export function buildCodexConfigForAuth(auth: CodexCliAuth) {
  if (auth.kind === "chatgpt") return buildCodexSubscriptionConfig();
  return buildCodexConfig({
    baseUrl: auth.baseUrl,
    apiKeyEnvVar: auth.apiKeyEnvVar,
  });
}

export function buildCodexJsonConfigForAuth(auth: CodexCliAuth): Record<string, unknown> {
  const common = {
    model_verbosity: "medium",
    features: { goals: true },
    sandbox_workspace_write: { network_access: true },
  };
  if (auth.kind === "chatgpt") {
    return {
      ...common,
      cli_auth_credentials_store: "file",
      forced_login_method: "chatgpt",
    };
  }
  return {
    ...common,
    model_provider: CODEX_PROVIDER_ID,
    model_providers: {
      [CODEX_PROVIDER_ID]: {
        name: CODEX_PROVIDER_NAME,
        base_url: auth.baseUrl,
        env_key: auth.apiKeyEnvVar,
        wire_api: "responses",
      },
    },
  };
}

export function codexApiKeyFallbackEnabled() {
  const value = process.env.RUNNER_CODEX_API_KEY_FALLBACK_ENABLED?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return process.env.NODE_ENV !== "production";
}

function tomlString(value: string) {
  return JSON.stringify(value);
}
