import { serializeActionPolicy } from "@opencompany/browser-tools";
import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";

export const GOAT_CHAT_SANDBOX_TIMEOUT_MS = 10 * 60 * 1_000;
export const GOAT_CHAT_SANDBOX_SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1_000;
export const GOAT_CHAT_SANDBOX_ROOT = "/vercel/sandbox/.opencompany";
export const GOAT_CHAT_SANDBOX_ACTION_POLICY_PATH = `${GOAT_CHAT_SANDBOX_ROOT}/action-policy.json`;
export const GOAT_CHAT_SANDBOX_SCREENSHOT_DIR = `${GOAT_CHAT_SANDBOX_ROOT}/screenshots`;
export const GOAT_CHAT_SANDBOX_AGENT_BROWSER_BIN = `${GOAT_CHAT_SANDBOX_ROOT}/agent-browser/node_modules/.bin/agent-browser`;
// Keep loopback available for agent-browser's local daemon and Chromium CDP.
// The Sandbox firewall still blocks private, carrier-grade NAT, and metadata egress.
// Vercel currently rejects IPv6 CIDRs in subnet policies, so these ranges are IPv4-only.
export const GOAT_CHAT_SANDBOX_NETWORK_POLICY: NetworkPolicy = {
  allow: ["*"],
  subnets: {
    deny: [
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ],
  },
};

const AGENT_BROWSER_VERSION = "0.27.3";
const SANDBOX_COMMAND_OUTPUT_LIMIT = 20_000;

export type GoatChatSandbox = Sandbox;

export function goatChatSandboxName(chatSessionId: string) {
  const normalized = chatSessionId
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80);
  if (!normalized) throw new Error("A chat session id is required for the browser sandbox.");
  return `goat-chat-${normalized}`;
}

export async function getGoatChatSandbox(input: { chatSessionId: string; signal: AbortSignal }) {
  const image = process.env.CHAT_SANDBOX_IMAGE?.trim();
  return Sandbox.getOrCreate({
    name: goatChatSandboxName(input.chatSessionId),
    ...(image ? { image } : { runtime: "node24" as const }),
    persistent: true,
    timeout: GOAT_CHAT_SANDBOX_TIMEOUT_MS,
    snapshotExpiration: GOAT_CHAT_SANDBOX_SNAPSHOT_EXPIRATION_MS,
    keepLastSnapshots: {
      count: 1,
      expiration: GOAT_CHAT_SANDBOX_SNAPSHOT_EXPIRATION_MS,
    },
    networkPolicy: GOAT_CHAT_SANDBOX_NETWORK_POLICY,
    tags: {
      surface: "goat-chat",
      version: "browser-v1",
    },
    signal: input.signal,
    onCreate: (sandbox) =>
      provisionChatSandbox(sandbox, {
        installAgentBrowser: !image,
        signal: input.signal,
      }),
  });
}

export async function provisionChatSandbox(
  sandbox: GoatChatSandbox,
  input: { installAgentBrowser: boolean; signal: AbortSignal },
) {
  const directories = await runSandboxCommand(sandbox, {
    cmd: "mkdir",
    args: ["-p", GOAT_CHAT_SANDBOX_SCREENSHOT_DIR],
    signal: input.signal,
    timeoutMs: 10_000,
  });
  assertProvisioningCommand(directories, "create browser sandbox directories");
  await sandbox.writeFiles(
    [
      {
        path: GOAT_CHAT_SANDBOX_ACTION_POLICY_PATH,
        content: serializeActionPolicy(),
        mode: 0o600,
      },
    ],
    { signal: input.signal },
  );
  if (!input.installAgentBrowser) return;

  const install = await runSandboxCommand(sandbox, {
    cmd: "npm",
    args: [
      "install",
      "--prefix",
      `${GOAT_CHAT_SANDBOX_ROOT}/agent-browser`,
      `agent-browser@${AGENT_BROWSER_VERSION}`,
      "--no-audit",
      "--no-fund",
    ],
    signal: input.signal,
    timeoutMs: 120_000,
  });
  assertProvisioningCommand(install, "install agent-browser");

  // agent-browser uses sudo for system packages while keeping Chrome in the
  // sandbox user's home, where later browser commands can discover it.
  const browser = await runSandboxCommand(sandbox, {
    cmd: GOAT_CHAT_SANDBOX_AGENT_BROWSER_BIN,
    args: ["install", "--with-deps"],
    signal: input.signal,
    timeoutMs: 5 * 60 * 1_000,
    env: sandboxBrowserEnvironment(),
  });
  assertProvisioningCommand(browser, "install Chromium");

  const permissions = await runSandboxCommand(sandbox, {
    cmd: "chmod",
    args: ["-R", "a+rX", `${GOAT_CHAT_SANDBOX_ROOT}/agent-browser`],
    signal: input.signal,
    timeoutMs: 10_000,
  });
  assertProvisioningCommand(permissions, "make the browser runtime readable");
}

export type SandboxCommandResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export async function runSandboxCommand(
  sandbox: Pick<GoatChatSandbox, "runCommand">,
  input: {
    cmd: string;
    args: string[];
    signal: AbortSignal;
    timeoutMs: number;
    env?: Record<string, string>;
  },
): Promise<SandboxCommandResult> {
  try {
    const command = await sandbox.runCommand({
      cmd: input.cmd,
      args: input.args,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      ...(input.env ? { env: input.env } : {}),
    });
    const [stdout, stderr] = await Promise.all([
      command.stdout({ signal: input.signal }),
      command.stderr({ signal: input.signal }),
    ]);
    const result = {
      ok: command.exitCode === 0,
      exitCode: command.exitCode,
      stdout: truncate(stdout.trim(), SANDBOX_COMMAND_OUTPUT_LIMIT),
      stderr: truncate(stderr.trim(), SANDBOX_COMMAND_OUTPUT_LIMIT),
    };
    return result.ok
      ? result
      : {
          ...result,
          error:
            firstNonEmptyLine(result.stderr, result.stdout) ??
            `Command exited with status ${command.exitCode}.`,
        };
  } catch (error) {
    if (input.signal.aborted) throw error;
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : "Sandbox command failed.",
    };
  }
}

export function sandboxBrowserEnvironment() {
  return {
    AGENT_BROWSER_SCREENSHOT_DIR: GOAT_CHAT_SANDBOX_SCREENSHOT_DIR,
  };
}

function assertProvisioningCommand(result: SandboxCommandResult, action: string) {
  if (result.ok) return;
  throw new Error(`Could not ${action}: ${result.error ?? "command failed"}`);
}

function firstNonEmptyLine(...values: string[]) {
  for (const value of values) {
    const line = value
      .split("\n")
      .map((entry) => entry.trim())
      .find(Boolean);
    if (line) return line;
  }
  return undefined;
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
