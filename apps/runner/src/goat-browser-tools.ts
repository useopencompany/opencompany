import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RunnerEnv } from "./env";
import type { HostedToolUsage } from "./hosted-tools";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
let agentBrowserReadSupportPromise: Promise<boolean> | undefined;

export type GoatBrowserToolName =
  | "browser_open"
  | "browser_snapshot"
  | "browser_click"
  | "browser_fill"
  | "browser_wait"
  | "browser_read"
  | "browser_get"
  | "browser_find"
  | "browser_scroll"
  | "browser_screenshot"
  | "browser_close";

const GOAT_BROWSER_TOOL_NAMES = new Set<GoatBrowserToolName>([
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_wait",
  "browser_read",
  "browser_get",
  "browser_find",
  "browser_scroll",
  "browser_screenshot",
  "browser_close",
]);

const AGENT_BROWSER_MAX_OUTPUT = "20000";
const BROWSER_MODEL_SINGLE_OUTPUT_LIMIT = 12_000;
const BROWSER_MODEL_CUMULATIVE_OUTPUT_LIMIT = 40_000;
const BROWSER_MODEL_SNAPSHOT_LIMIT = 6;
const AGENT_BROWSER_TIMEOUT_MS = 120_000;
export const AGENT_BROWSER_ACTION_POLICY = {
  default: "deny",
  allow: [
    "launch",
    "navigate",
    "snapshot",
    "click",
    "type",
    "fill",
    "scroll",
    "wait",
    "screenshot",
    "read",
    "find",
    "get",
    "interact",
    "getbyrole",
    "getbytext",
    "getbylabel",
    "getbyplaceholder",
    "getbyalttext",
    "getbytitle",
    "getbytestid",
    "first",
    "last",
    "nth",
    "url",
    "title",
    "gettext",
    "inputvalue",
    "getattribute",
    "count",
  ],
  deny: ["eval", "download", "upload", "network", "state"],
};

export function isGoatBrowserToolName(name: string): name is GoatBrowserToolName {
  return GOAT_BROWSER_TOOL_NAMES.has(name as GoatBrowserToolName);
}

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

export function buildAgentBrowserCommand(input: {
  name: GoatBrowserToolName;
  args: unknown;
  sessionId: string;
  actionPolicyPath: string;
}): string[] {
  const args = [
    "--session",
    input.sessionId,
    "--content-boundaries",
    "--max-output",
    AGENT_BROWSER_MAX_OUTPUT,
    "--action-policy",
    input.actionPolicyPath,
  ];

  switch (input.name) {
    case "browser_open": {
      const record = asRecord(input.args);
      args.push("open", readHttpUrl(record, "url", "browser_open url"));
      return args;
    }
    case "browser_snapshot": {
      const record = asRecord(input.args);
      args.push("snapshot");
      if (readOptionalBoolean(record, "interactive") ?? true) args.push("-i");
      if (readOptionalBoolean(record, "compact") ?? true) args.push("-c");
      args.push("-d", String(readDepth(record, 5)));
      const selector = readOptionalString(record, "selector");
      if (selector) args.push("-s", selector);
      if (readOptionalBoolean(record, "includeUrls")) args.push("--urls");
      return args;
    }
    case "browser_click": {
      const record = asRecord(input.args);
      args.push("click", readRef(record, "ref"));
      return args;
    }
    case "browser_fill": {
      const record = asRecord(input.args);
      args.push("fill", readRef(record, "ref"), readRequiredString(record, "text"));
      return args;
    }
    case "browser_wait": {
      const record = asRecord(input.args);
      args.push("wait");
      const milliseconds = readOptionalNumber(record, "milliseconds");
      const ref = readOptionalString(record, "ref");
      const text = readOptionalString(record, "text");
      const urlPattern = readOptionalString(record, "urlPattern");
      const loadState = readOptionalString(record, "loadState");
      if (milliseconds !== undefined) {
        args.push(String(clampInteger(milliseconds, 100, 30_000)));
      } else if (ref) {
        args.push(normalizeRef(ref));
      } else if (text) {
        args.push("--text", text);
      } else if (urlPattern) {
        args.push("--url", urlPattern);
      } else if (loadState) {
        if (!["load", "domcontentloaded", "networkidle"].includes(loadState)) {
          throw new Error("browser_wait loadState must be load, domcontentloaded, or networkidle.");
        }
        args.push("--load", loadState);
      } else {
        args.push("1000");
      }
      return args;
    }
    case "browser_read": {
      args.push("get", "text", "body");
      return args;
    }
    case "browser_get": {
      const record = asRecord(input.args);
      const target = readBrowserGetTarget(record);
      args.push("get", target);
      const selector = readOptionalRefOrSelector(record);
      if (selector) {
        args.push(selector);
      } else if (target === "text") {
        args.push("body");
      }
      if (target === "attr") {
        args.push(readRequiredString(record, "attribute"));
      }
      return args;
    }
    case "browser_find": {
      const record = asRecord(input.args);
      args.push("find", readFindBy(record));
      const nth = readOptionalNumber(record, "index");
      if (readOptionalString(record, "by") === "nth") {
        if (nth === undefined) throw new Error("browser_find index is required when by is nth.");
        args.push(String(clampInteger(nth, 0, 10_000)));
      }
      args.push(readRequiredString(record, "value"), readFindAction(record));
      const text = readOptionalString(record, "text");
      if (text) args.push(text);
      const name = readOptionalString(record, "name");
      if (name) args.push("--name", name);
      if (readOptionalBoolean(record, "exact")) args.push("--exact");
      return args;
    }
    case "browser_scroll": {
      const record = asRecord(input.args);
      args.push("scroll", readScrollDirection(record), String(readScrollPixels(record)));
      return args;
    }
    case "browser_screenshot": {
      const record = asRecord(input.args);
      args.push("screenshot");
      if (readOptionalBoolean(record, "fullPage")) args.push("--full");
      if (readOptionalBoolean(record, "annotate")) args.push("--annotate");
      return args;
    }
    case "browser_close":
      args.push("close");
      return args;
  }
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
  const args = buildAgentBrowserCommand({
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
    const args = buildAgentBrowserReadCommand({
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
    const openArgs = buildAgentBrowserCommand({
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

  const args = buildAgentBrowserCommand({
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

export function buildAgentBrowserReadCommand(input: {
  args: unknown;
  sessionId: string;
  actionPolicyPath: string;
}) {
  const record = asRecord(input.args);
  const args = [
    "--session",
    input.sessionId,
    "--content-boundaries",
    "--max-output",
    AGENT_BROWSER_MAX_OUTPUT,
    "--action-policy",
    input.actionPolicyPath,
    "read",
  ];
  const url = readOptionalString(record, "url");
  if (url) args.push(readHttpUrl(record, "url", "browser_read url"));
  const filter = readOptionalString(record, "filter");
  if (filter) args.push("--filter", filter);
  if (readOptionalBoolean(record, "outline")) args.push("--outline");
  return args;
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
      output: truncate(result.stdout.trim(), Number(AGENT_BROWSER_MAX_OUTPUT)),
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
  const contents = `${JSON.stringify(AGENT_BROWSER_ACTION_POLICY, null, 2)}\n`;
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

export function createBrowserObservationBudget() {
  return {
    cumulativeOutputChars: 0,
    largestOutputChars: 0,
    snapshotCount: 0,
  };
}

export function modelFacingBrowserOutput(input: {
  name: GoatBrowserToolName;
  output: unknown;
  budget: ReturnType<typeof createBrowserObservationBudget>;
}) {
  const record = asRecord(input.output);
  const text = typeof record.output === "string" ? record.output : "";
  if (!text) return input.output;

  const outputChars = text.length;
  input.budget.cumulativeOutputChars += outputChars;
  input.budget.largestOutputChars = Math.max(input.budget.largestOutputChars, outputChars);
  if (input.name === "browser_snapshot") input.budget.snapshotCount += 1;

  if (!shouldCompactBrowserOutput(input.name, outputChars, input.budget)) return input.output;

  return {
    ...record,
    output: compactBrowserObservation(text),
    compacted: true,
    originalOutputChars: outputChars,
    browserObservationBudget: {
      cumulativeOutputChars: input.budget.cumulativeOutputChars,
      largestOutputChars: input.budget.largestOutputChars,
      snapshotCount: input.budget.snapshotCount,
      maxSingleOutputChars: BROWSER_MODEL_SINGLE_OUTPUT_LIMIT,
      maxCumulativeOutputChars: BROWSER_MODEL_CUMULATIVE_OUTPUT_LIMIT,
      maxSnapshots: BROWSER_MODEL_SNAPSHOT_LIMIT,
    },
  };
}

function shouldCompactBrowserOutput(
  name: GoatBrowserToolName,
  outputChars: number,
  budget: ReturnType<typeof createBrowserObservationBudget>,
) {
  if (!["browser_snapshot", "browser_read", "browser_get", "browser_find"].includes(name)) {
    return false;
  }
  return (
    outputChars > BROWSER_MODEL_SINGLE_OUTPUT_LIMIT ||
    budget.cumulativeOutputChars > BROWSER_MODEL_CUMULATIVE_OUTPUT_LIMIT ||
    budget.snapshotCount > BROWSER_MODEL_SNAPSHOT_LIMIT
  );
}

function compactBrowserObservation(value: string) {
  const lines = value.split("\n");
  const headerLines = lines
    .filter((line) => /^--- AGENT_BROWSER_PAGE_CONTENT|^Page:|^URL:/.test(line))
    .slice(0, 6);
  const refLines = lines.filter((line) => /\bref=e\d+\]|@e\d+\b/.test(line)).slice(0, 140);
  const otherLines = lines
    .filter((line) => line.trim() && !/\bref=e\d+\]|@e\d+\b/.test(line))
    .slice(0, 40);
  const body = [...headerLines, ...refLines, ...otherLines].join("\n");
  return [
    body ? truncate(body, BROWSER_MODEL_SINGLE_OUTPUT_LIMIT - 700) : "",
    "",
    "[Browser output compacted for model context. The full bounded output is retained in the task transcript. Use browser_get, browser_find, browser_read with filter, or browser_snapshot with selector/depth for targeted follow-up.]",
  ]
    .filter(Boolean)
    .join("\n");
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readHttpUrl(record: Record<string, unknown>, key: string, label: string) {
  const value = readRequiredString(record, key);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }
  return url.toString();
}

function readDepth(record: Record<string, unknown>, defaultValue: number) {
  const value = readOptionalNumber(record, "depth");
  return value === undefined ? defaultValue : clampInteger(value, 1, 10);
}

function readBrowserGetTarget(record: Record<string, unknown>) {
  const target = readRequiredString(record, "target");
  if (!["url", "title", "text", "value", "attr", "count"].includes(target)) {
    throw new Error("browser_get target must be url, title, text, value, attr, or count.");
  }
  if (target === "attr") readRequiredString(record, "attribute");
  if (["text", "value", "attr", "count"].includes(target)) {
    const selector = readOptionalRefOrSelector(record);
    if (!selector && target !== "text") {
      throw new Error(`browser_get ${target} requires ref or selector.`);
    }
  }
  return target;
}

function readOptionalRefOrSelector(record: Record<string, unknown>) {
  const ref = readOptionalString(record, "ref");
  if (ref) return normalizeRef(ref);
  return readOptionalString(record, "selector");
}

function readFindBy(record: Record<string, unknown>) {
  const by = readRequiredString(record, "by");
  if (
    ![
      "role",
      "text",
      "label",
      "placeholder",
      "alt",
      "title",
      "testid",
      "first",
      "last",
      "nth",
    ].includes(by)
  ) {
    throw new Error(
      "browser_find by must be role, text, label, placeholder, alt, title, testid, first, last, or nth.",
    );
  }
  return by;
}

function readFindAction(record: Record<string, unknown>) {
  const action = readRequiredString(record, "action");
  if (!["click", "fill", "type", "hover", "focus", "check", "uncheck"].includes(action)) {
    throw new Error(
      "browser_find action must be click, fill, type, hover, focus, check, or uncheck.",
    );
  }
  if (action === "fill" || action === "type") readRequiredString(record, "text");
  return action;
}

function setOptionalProcessEnv(env: NodeJS.ProcessEnv, key: string, value: string | undefined) {
  const normalized = value?.trim();
  if (normalized) {
    env[key] = normalized;
  } else {
    delete env[key];
  }
}

function readScrollDirection(record: Record<string, unknown>) {
  const direction = readRequiredString(record, "direction");
  if (!["up", "down", "left", "right"].includes(direction)) {
    throw new Error("browser_scroll direction must be up, down, left, or right.");
  }
  return direction;
}

function readScrollPixels(record: Record<string, unknown>) {
  const pixels = readOptionalNumber(record, "pixels") ?? 800;
  return clampInteger(pixels, 1, 5000);
}

function readRef(record: Record<string, unknown>, key: string) {
  return normalizeRef(readRequiredString(record, key));
}

function normalizeRef(value: string) {
  const ref = value.trim();
  if (!/^@?e\d+$/.test(ref)) {
    throw new Error("Browser element refs must look like @e1.");
  }
  return ref.startsWith("@") ? ref : `@${ref}`;
}

function readRequiredString(record: Record<string, unknown>, key: string) {
  const value = readOptionalString(record, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.floor(value), min), max);
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function agentBrowserErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "agent-browser command failed.";
}
