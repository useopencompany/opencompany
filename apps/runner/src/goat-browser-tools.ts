import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_BROWSER_MAX_OUTPUT,
  asRecord,
  type BrowserToolName,
  buildBrowserReadArgv,
  buildBrowserToolArgv,
  createBrowserObservationBudget,
  isBrowserToolName,
  modelFacingBrowserOutput,
  readHttpUrl,
  readOptionalString,
  serializeActionPolicy,
} from "@opencompany/browser-tools";
import type { RunnerEnv } from "./env";
import type { HostedToolUsage } from "./hosted-tools";

export {
  AGENT_BROWSER_ACTION_POLICY,
  createBrowserObservationBudget,
  modelFacingBrowserOutput,
} from "@opencompany/browser-tools";
export type GoatBrowserToolName = BrowserToolName;
export const isGoatBrowserToolName = isBrowserToolName;
export const buildAgentBrowserCommand = buildBrowserToolArgv;
export const buildAgentBrowserReadCommand = buildBrowserReadArgv;

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const AGENT_BROWSER_TIMEOUT_MS = 120_000;
let agentBrowserReadSupportPromise: Promise<boolean> | undefined;

export type GoatBrowserToolSession = {
  execute(input: { name: GoatBrowserToolName; args: unknown }): Promise<{
    output: unknown;
    transcriptOutput?: unknown;
    usage: HostedToolUsage;
  }>;
  cleanup(): Promise<void>;
};

export function createGoatBrowserToolSession(input: {
  taskId?: string;
  env: RunnerEnv;
  signal: AbortSignal;
}): GoatBrowserToolSession {
  validateBrowserEnvironment(input.env);
  const sessionId = buildBrowserSessionId(input.taskId);
  const budget = createBrowserObservationBudget();

  return {
    execute: async ({ name, args }) => {
      const transcriptOutput = await executeAgentBrowserCommand({
        name,
        args,
        sessionId,
        env: input.env,
        signal: input.signal,
      });
      const output = modelFacingBrowserOutput({
        name,
        output: transcriptOutput,
        budget,
      });
      return {
        output,
        transcriptOutput,
        usage: {
          provider: "browser",
          operation: browserOperation(name),
          costUsdMicros: 0,
          costSource: "subscription",
          rawUsage: {
            display_only: true,
            toolName: name,
            provider: input.env.agentBrowserProvider ?? "local",
            sessionId,
            browserObservation: {
              cumulativeOutputChars: budget.cumulativeOutputChars,
              largestOutputChars: budget.largestOutputChars,
              snapshotCount: budget.snapshotCount,
            },
          },
        },
      };
    },
    cleanup: async () => {
      try {
        await executeAgentBrowserCommand({
          name: "browser_close",
          args: {},
          sessionId,
          env: input.env,
          signal: input.signal,
        });
      } catch {
        // Cleanup is best-effort; the task result should not fail because session close failed.
      }
    },
  };
}

export function buildAgentBrowserEnvironment(env: RunnerEnv): NodeJS.ProcessEnv {
  const output = { ...process.env };
  setOptionalProcessEnv(output, "AGENT_BROWSER_BIN", process.env.AGENT_BROWSER_BIN);
  setOptionalProcessEnv(output, "AGENT_BROWSER_PROVIDER", env.agentBrowserProvider);
  setOptionalProcessEnv(output, "BROWSERLESS_API_KEY", env.browserlessApiKey);
  setOptionalProcessEnv(output, "BROWSERLESS_API_URL", env.browserlessApiUrl);
  setOptionalProcessEnv(output, "BROWSERLESS_TTL", env.browserlessTtl);
  setOptionalProcessEnv(output, "BROWSERLESS_STEALTH", env.browserlessStealth);
  return output;
}

export function resolveAgentBrowserExecutable() {
  const configuredBin = process.env.AGENT_BROWSER_BIN?.trim();
  if (configuredBin) return configuredBin;

  const binaryName = agentBrowserBinaryName();
  if (!binaryName) return "agent-browser";

  try {
    const packageRoot = dirname(require.resolve("agent-browser/package.json"));
    const packageBinary = join(packageRoot, "bin", binaryName);
    if (existsSync(packageBinary)) return packageBinary;
  } catch {
    // Fall back to PATH for global installs or package-manager shims.
  }

  return "agent-browser";
}

async function executeAgentBrowserCommand(input: {
  name: GoatBrowserToolName;
  args: unknown;
  sessionId: string;
  env: RunnerEnv;
  signal: AbortSignal;
}) {
  const actionPolicyPath = await ensureAgentBrowserActionPolicy();
  if (input.name === "browser_read") {
    return executeAgentBrowserReadCommand({
      args: input.args,
      sessionId: input.sessionId,
      env: input.env,
      signal: input.signal,
      actionPolicyPath,
    });
  }
  const args = buildBrowserToolArgv({
    name: input.name,
    args: input.args,
    sessionId: input.sessionId,
    actionPolicyPath,
  });
  return runAgentBrowserCli({
    name: input.name,
    args,
    env: input.env,
    signal: input.signal,
  });
}

async function executeAgentBrowserReadCommand(input: {
  args: unknown;
  sessionId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  actionPolicyPath: string;
}) {
  const record = asRecord(input.args);
  if (await agentBrowserSupportsReadCommand(input.env, input.signal)) {
    const args = buildBrowserReadArgv({
      args: input.args,
      sessionId: input.sessionId,
      actionPolicyPath: input.actionPolicyPath,
    });
    return runAgentBrowserCli({
      name: "browser_read",
      args,
      env: input.env,
      signal: input.signal,
    });
  }

  const url = readOptionalString(record, "url");
  if (url) {
    const openArgs = buildBrowserToolArgv({
      name: "browser_open",
      args: { url: readHttpUrl(record, "url", "browser_read url") },
      sessionId: input.sessionId,
      actionPolicyPath: input.actionPolicyPath,
    });
    const opened = await runAgentBrowserCli({
      name: "browser_read",
      args: openArgs,
      env: input.env,
      signal: input.signal,
    });
    if (!opened.ok) return opened;
  }

  const args = buildBrowserToolArgv({
    name: "browser_read",
    args: input.args,
    sessionId: input.sessionId,
    actionPolicyPath: input.actionPolicyPath,
  });
  const output = await runAgentBrowserCli({
    name: "browser_read",
    args,
    env: input.env,
    signal: input.signal,
  });
  if (!output.ok) return output;

  const filter = readOptionalString(record, "filter");
  if (!filter || typeof output.output !== "string") return output;
  return {
    ...output,
    output: output.output
      .split("\n")
      .filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
      .join("\n"),
  };
}

export function agentBrowserSupportsReadCommand(env: RunnerEnv, signal: AbortSignal) {
  agentBrowserReadSupportPromise ??= detectAgentBrowserReadCommand(env, signal);
  return agentBrowserReadSupportPromise;
}

async function detectAgentBrowserReadCommand(env: RunnerEnv, signal: AbortSignal) {
  try {
    const result = await execFileAsync(resolveAgentBrowserExecutable(), ["--help"], {
      env: buildAgentBrowserEnvironment(env),
      signal,
      timeout: 10_000,
      maxBuffer: 512 * 1024,
    });
    return /^  read\b|^\s*read\b/m.test(result.stdout);
  } catch {
    return false;
  }
}

async function runAgentBrowserCli(input: {
  name: GoatBrowserToolName;
  args: string[];
  env: RunnerEnv;
  signal: AbortSignal;
}) {
  try {
    const result = await execFileAsync(resolveAgentBrowserExecutable(), input.args, {
      env: buildAgentBrowserEnvironment(input.env),
      signal: input.signal,
      timeout: AGENT_BROWSER_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      command: input.name,
      output: truncate(result.stdout.trim(), AGENT_BROWSER_MAX_OUTPUT),
      stderr: truncate(result.stderr.trim(), 4_000),
    };
  } catch (error) {
    if (input.signal.aborted) throw error;
    return {
      ok: false,
      command: input.name,
      error: agentBrowserErrorMessage(error),
    };
  }
}

async function ensureAgentBrowserActionPolicy() {
  const contents = serializeActionPolicy();
  const digest = createHash("sha256").update(contents).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "opencompany-goat-agent-browser");
  const path = join(dir, `action-policy-${digest}.json`);
  await mkdir(dir, { recursive: true });
  try {
    if ((await readFile(path, "utf8")) === contents) return path;
  } catch {
    // Create or repair the policy file below.
  }
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

function validateBrowserEnvironment(env: RunnerEnv) {
  if (!env.goatBrowserEnabled) {
    throw new Error("Browser tools are disabled. Set RUNNER_GOAT_BROWSER_ENABLED=true.");
  }
  if (env.agentBrowserProvider === "browserless" && !env.browserlessApiKey) {
    throw new Error(
      "Browser tools are enabled with AGENT_BROWSER_PROVIDER=browserless, but BROWSERLESS_API_KEY is not configured.",
    );
  }
}

function buildBrowserSessionId(taskId: string | undefined) {
  const raw = taskId?.trim() || "ad-hoc";
  return `goat-task-${raw.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function agentBrowserBinaryName() {
  const os = platform();
  const cpuArch = arch();
  const osKey =
    os === "darwin"
      ? "darwin"
      : os === "linux"
        ? isMuslRuntime()
          ? "linux-musl"
          : "linux"
        : os === "win32"
          ? "win32"
          : "";
  const archKey = cpuArch === "arm64" ? "arm64" : cpuArch === "x64" ? "x64" : "";
  if (!osKey || !archKey) return "";
  return `agent-browser-${osKey}-${archKey}${os === "win32" ? ".exe" : ""}`;
}

function isMuslRuntime() {
  if (platform() !== "linux") return false;
  const report =
    typeof process.report?.getReport === "function"
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : undefined;
  return !report?.header?.glibcVersionRuntime;
}

function browserOperation(name: GoatBrowserToolName) {
  return name.replace(/^browser_/, "");
}

function setOptionalProcessEnv(env: NodeJS.ProcessEnv, key: string, value: string | undefined) {
  const normalized = value?.trim();
  if (normalized) {
    env[key] = normalized;
  } else {
    delete env[key];
  }
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function agentBrowserErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "agent-browser command failed.";
}
