import { shellQuote } from "@opencompany/agent-runtime";
import {
  GOAT_INFISICAL_AUTH_BUNDLE_FORMAT_VERSION,
  type GoatInfisicalAuthBundle,
  type GoatInfisicalHost,
  isGoatInfisicalHost,
  isGoatInfisicalSessionDomain,
  newGoatInfisicalAuthFlowId,
  saveGoatInfisicalConnection,
} from "@opencompany/db/goat-infisical-auth";
import { goatInfisicalAuthFlows } from "@opencompany/db/goat-schema";
import { requireGoatWorkspaceAdmin } from "@opencompany/db/goat-workspaces";
import { createLogger } from "@opencompany/observability";
import { and, eq, inArray } from "drizzle-orm";
import { Sandbox } from "e2b";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { INFISICAL_CLI_LINUX_AMD64_SHA256, INFISICAL_CLI_VERSION } from "./infisical-version";
import { killSandbox, type SandboxHandle } from "./sandbox";

const logger = createLogger({ service: "opencompany-runner", runtime: "infisical-auth" });

const INFISICAL_AUTH_HOME = "/home/user/.opencompany/infisical-auth";
const INFISICAL_CONFIG_PATH = "/home/user/.infisical/infisical-config.json";
const INFISICAL_KEYRING_ROOT = "/home/user/infisical-keyring";
const INFISICAL_LOGIN_SCRIPT = `${INFISICAL_AUTH_HOME}/login.sh`;
const INFISICAL_LOGIN_EXIT = `${INFISICAL_AUTH_HOME}/login.exit`;
const INFISICAL_BROWSER_TOKEN_PATH = `${INFISICAL_AUTH_HOME}/browser-token`;
const INFISICAL_TMUX_SESSION = "opencompany-infisical-auth";
const INFISICAL_AUTH_FLOW_TTL_MS = 10 * 60_000;
const INFISICAL_AUTH_SANDBOX_TIMEOUT_MS = 12 * 60_000;
const INFISICAL_LINK_WAIT_MS = 15_000;
const INFISICAL_LOGIN_COMPLETION_WAIT_MS = 60_000;
const INFISICAL_BROWSER_TOKEN_MAX_LENGTH = 64 * 1024;
const INFISICAL_BUNDLE_MAX_BYTES = 512 * 1024;
const INFISICAL_KEYRING_MAX_FILES = 5;

type InfisicalAuthStartStage =
  | "supersede_active_flows"
  | "create_sandbox"
  | "set_sandbox_timeout"
  | "install_infisical_cli"
  | "install_tmux"
  | "prepare_login"
  | "wait_for_login_url"
  | "persist_flow";

export type InfisicalAuthFlowStatus = {
  id: string;
  status: "pending" | "link_ready" | "completed" | "failed" | "expired";
  loginUrl: string | null;
  statusReason: string | null;
  expiresAt: string;
};

export async function startGoatInfisicalAuthFlow(input: {
  workspaceId: string;
  requestedByWorkosId: string;
  host: GoatInfisicalHost;
  env: RunnerEnv;
}): Promise<InfisicalAuthFlowStatus> {
  await requireWorkspaceAdmin(input.workspaceId, input.requestedByWorkosId);
  if (!isGoatInfisicalHost(input.host)) {
    throw new Error("Unsupported Infisical host.");
  }
  let failureStage: InfisicalAuthStartStage = "supersede_active_flows";
  let sandbox: SandboxHandle | null = null;
  try {
    await supersedeActiveFlows(input.workspaceId);

    failureStage = "create_sandbox";
    const createdSandbox = await Sandbox.create(input.env.codexE2bTemplate ?? "codex", {
      envs: {},
      metadata: {
        user_id: input.requestedByWorkosId,
        workspace_id: input.workspaceId,
        purpose: "infisical-auth",
      },
      timeoutMs: INFISICAL_AUTH_SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "kill" },
    });
    sandbox = createdSandbox;

    failureStage = "set_sandbox_timeout";
    await createdSandbox.setTimeout(INFISICAL_AUTH_SANDBOX_TIMEOUT_MS);

    failureStage = "install_infisical_cli";
    await ensureInfisicalInstalled(createdSandbox);

    failureStage = "install_tmux";
    await ensureInfisicalTmuxInstalled(createdSandbox);

    failureStage = "prepare_login";
    await prepareInfisicalAuthSandbox(createdSandbox, input.host);

    failureStage = "wait_for_login_url";
    const loginUrl = await waitForLoginUrl(createdSandbox, input.host);
    if (!loginUrl) {
      throw new Error("Infisical did not provide a browser login link.");
    }

    const id = newGoatInfisicalAuthFlowId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INFISICAL_AUTH_FLOW_TTL_MS);
    failureStage = "persist_flow";
    await getDb().insert(goatInfisicalAuthFlows).values({
      id,
      workspaceId: input.workspaceId,
      requestedByWorkosId: input.requestedByWorkosId,
      sandboxId: createdSandbox.sandboxId,
      loginUrl,
      status: "link_ready",
      statusReason: null,
      expiresAt,
      updatedAt: now,
    });
    logger.info("Infisical auth flow is ready", {
      event: "opencompany.runner_infisical_auth_link_ready",
      workspace_id: input.workspaceId,
      flow_id: id,
      sandbox_id: createdSandbox.sandboxId,
      infisical_host: input.host,
    });
    return {
      id,
      status: "link_ready",
      loginUrl,
      statusReason: null,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    if (sandbox) await killSandbox(sandbox.sandboxId).catch(() => undefined);
    logger.warn("Infisical auth flow could not start", {
      event: "opencompany.runner_infisical_auth_start_failed",
      workspace_id: input.workspaceId,
      sandbox_id: sandbox?.sandboxId,
      failure_stage: failureStage,
      error_name: errorName(error),
    });
    throw error;
  }
}

export async function completeGoatInfisicalAuthFlow(input: {
  workspaceId: string;
  requestedByWorkosId: string;
  flowId: string;
  browserToken: string;
}): Promise<InfisicalAuthFlowStatus | null> {
  await requireWorkspaceAdmin(input.workspaceId, input.requestedByWorkosId);
  const flow = await loadFlow(input.workspaceId, input.requestedByWorkosId, input.flowId);
  if (!flow) return null;
  if (isTerminalStatus(flow.status)) return flowStatus(flow);

  const host = infisicalHostFromLoginUrl(flow.loginUrl);
  if (!host) {
    throw new Error("Infisical authentication flow has an unsupported host.");
  }

  const now = new Date();
  if (flow.expiresAt <= now) {
    await markFlowTerminal({
      workspaceId: input.workspaceId,
      flowId: input.flowId,
      status: "expired",
      statusReason: "Infisical authentication expired. Start a new connection.",
      now,
    });
    await killSandbox(flow.sandboxId).catch(() => undefined);
    return {
      ...flowStatus(flow),
      status: "expired",
      statusReason: "Infisical authentication expired. Start a new connection.",
    };
  }

  const browserCredentials = decodeInfisicalBrowserToken(input.browserToken);
  let sandbox: SandboxHandle;
  try {
    sandbox = await Sandbox.connect(flow.sandboxId, {
      timeoutMs: INFISICAL_AUTH_SANDBOX_TIMEOUT_MS,
      requestTimeoutMs: 30_000,
    });
  } catch {
    await markFlowTerminal({
      workspaceId: input.workspaceId,
      flowId: input.flowId,
      status: "failed",
      statusReason: "The Infisical authentication sandbox is no longer available.",
      now,
    });
    return {
      ...flowStatus(flow),
      status: "failed",
      statusReason: "The Infisical authentication sandbox is no longer available.",
    };
  }

  try {
    const promptReady = await waitForBrowserTokenPrompt(sandbox);
    if (!promptReady) {
      throw new Error("Infisical was not ready to accept the browser token.");
    }
    await submitBrowserToken(sandbox, input.browserToken);
    const exitCode = await waitForLoginExit(sandbox);
    if (exitCode !== 0) {
      throw new Error("Infisical rejected the browser token.");
    }

    const loginStatus = await validateInfisicalLogin(sandbox, host);
    if (loginStatus.email !== browserCredentials.email) {
      throw new Error("Infisical authenticated a different account than the browser token.");
    }
    const authBundle = await captureInfisicalAuthBundle(sandbox, [
      input.browserToken,
      browserCredentials.jwt,
      browserCredentials.refreshToken,
      browserCredentials.privateKey,
    ]);
    await saveGoatInfisicalConnection({
      db: getDb(),
      workspaceId: input.workspaceId,
      authBundle,
      host,
      accountEmail: loginStatus.email,
      cliVersion: INFISICAL_CLI_VERSION,
      expiresAt: loginStatus.expiresAt,
      connectedByWorkosId: input.requestedByWorkosId,
      now,
    });
    await markFlowTerminal({
      workspaceId: input.workspaceId,
      flowId: input.flowId,
      status: "completed",
      statusReason: null,
      now,
    });
    logger.info("Infisical auth flow completed", {
      event: "opencompany.runner_infisical_auth_completed",
      workspace_id: input.workspaceId,
      flow_id: input.flowId,
      sandbox_id: flow.sandboxId,
      infisical_host: host,
    });
    return {
      ...flowStatus(flow),
      status: "completed",
      statusReason: null,
    };
  } catch (error) {
    const reason = safeCompletionError(error);
    await markFlowTerminal({
      workspaceId: input.workspaceId,
      flowId: input.flowId,
      status: "failed",
      statusReason: reason,
      now,
    });
    logger.warn("Infisical auth flow failed", {
      event: "opencompany.runner_infisical_auth_completion_failed",
      workspace_id: input.workspaceId,
      flow_id: input.flowId,
      sandbox_id: flow.sandboxId,
      error_name: errorName(error),
    });
    return { ...flowStatus(flow), status: "failed", statusReason: reason };
  } finally {
    await killSandbox(flow.sandboxId).catch(() => undefined);
  }
}

export function parseInfisicalLoginUrl(output: string, expectedHost: GoatInfisicalHost) {
  if (!isGoatInfisicalHost(expectedHost)) return null;
  const unwrappedOutput = output.replace(/\r?\n/g, "");
  const escapedHost = expectedHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = unwrappedOutput.match(new RegExp(`${escapedHost}/login\\?callback_port=\\d+`));
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    const callbackPort = Number(url.searchParams.get("callback_port"));
    return Number.isInteger(callbackPort) && callbackPort > 0 && callbackPort <= 65_535
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function infisicalHostFromLoginUrl(loginUrl: string | null): GoatInfisicalHost | null {
  if (!loginUrl) return null;
  try {
    const url = new URL(loginUrl);
    return url.pathname === "/login" && isGoatInfisicalHost(url.origin) ? url.origin : null;
  } catch {
    return null;
  }
}

export function decodeInfisicalBrowserToken(browserToken: string) {
  const token = browserToken.trim();
  if (!token || token.length > INFISICAL_BROWSER_TOKEN_MAX_LENGTH) {
    throw new Error("That does not look like a valid Infisical browser token.");
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    throw new Error("That does not look like a valid Infisical browser token.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("That does not look like a valid Infisical browser token.");
  }
  const credentials = value as Record<string, unknown>;
  const email = typeof credentials.email === "string" ? credentials.email.trim() : "";
  const jwt = typeof credentials.JTWToken === "string" ? credentials.JTWToken.trim() : "";
  const refreshToken =
    typeof credentials.RefreshToken === "string" ? credentials.RefreshToken.trim() : "";
  const privateKey =
    typeof credentials.privateKey === "string" ? credentials.privateKey.trim() : "";
  if (!email || !email.includes("@") || !jwt) {
    throw new Error("That does not look like a valid Infisical browser token.");
  }
  return { email, jwt, refreshToken, privateKey };
}

async function requireWorkspaceAdmin(workspaceId: string, requestedByWorkosId: string) {
  await requireGoatWorkspaceAdmin(
    { workspaceId, userWorkosId: requestedByWorkosId },
    { db: getDb() },
  );
}

async function supersedeActiveFlows(workspaceId: string) {
  const activeFlows = await getDb()
    .select({ id: goatInfisicalAuthFlows.id, sandboxId: goatInfisicalAuthFlows.sandboxId })
    .from(goatInfisicalAuthFlows)
    .where(
      and(
        eq(goatInfisicalAuthFlows.workspaceId, workspaceId),
        inArray(goatInfisicalAuthFlows.status, ["pending", "link_ready"]),
      ),
    );
  const now = new Date();
  for (const flow of activeFlows) {
    await markFlowTerminal({
      workspaceId,
      flowId: flow.id,
      status: "failed",
      statusReason: "Superseded by a new Infisical authentication attempt.",
      now,
    });
    await killSandbox(flow.sandboxId).catch(() => undefined);
  }
}

async function ensureInfisicalInstalled(sandbox: SandboxHandle) {
  const result = await sandbox.commands.run("infisical --version 2>/dev/null || true", {
    user: "user",
    timeoutMs: 30_000,
  });
  if (result.stdout.trim() === `infisical version ${INFISICAL_CLI_VERSION}`) return;

  const archiveUrl = `https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_amd64.tar.gz`;
  await sandbox.commands.run(
    [
      "infisical_install_dir=$(mktemp -d /tmp/opencompany-infisical.XXXXXX)",
      `curl -fsSL ${shellQuote(archiveUrl)} -o "$infisical_install_dir/infisical.tar.gz"`,
      `printf '%s  %s\\n' ${shellQuote(INFISICAL_CLI_LINUX_AMD64_SHA256)} "$infisical_install_dir/infisical.tar.gz" | sha256sum -c -`,
      'tar -xzf "$infisical_install_dir/infisical.tar.gz" -C "$infisical_install_dir" infisical',
      'install -m 0755 "$infisical_install_dir/infisical" /usr/local/bin/infisical',
      'rm -rf "$infisical_install_dir"',
      `test "$(infisical --version)" = ${shellQuote(`infisical version ${INFISICAL_CLI_VERSION}`)}`,
    ].join(" && "),
    { user: "root", timeoutMs: 180_000 },
  );
}

export async function ensureInfisicalTmuxInstalled(sandbox: SandboxHandle) {
  await sandbox.commands.run(
    [
      "if ! command -v tmux >/dev/null 2>&1; then",
      "export DEBIAN_FRONTEND=noninteractive;",
      "apt-get update -qq && apt-get install -y -qq --no-install-recommends tmux;",
      "fi;",
      "command -v tmux >/dev/null",
    ].join(" "),
    { user: "root", timeoutMs: 120_000 },
  );
}

async function prepareInfisicalAuthSandbox(sandbox: SandboxHandle, host: GoatInfisicalHost) {
  await sandbox.commands.run(
    [
      `rm -rf ${shellQuote(INFISICAL_AUTH_HOME)} ${shellQuote("/home/user/.infisical")} ${shellQuote(INFISICAL_KEYRING_ROOT)}`,
      `install -d -m 700 ${shellQuote(INFISICAL_AUTH_HOME)}`,
      `HOME=/home/user infisical vault set file >/dev/null 2>&1`,
    ].join(" && "),
    { user: "user", timeoutMs: 30_000 },
  );
  await sandbox.files.write(
    INFISICAL_LOGIN_SCRIPT,
    [
      "#!/usr/bin/env bash",
      "export HOME=/home/user",
      `infisical login --domain=${shellQuote(host)}`,
      "login_exit=$?",
      `printf '%s' "$login_exit" > ${shellQuote(INFISICAL_LOGIN_EXIT)}`,
      'exit "$login_exit"',
      "",
    ].join("\n"),
    { user: "user" },
  );
  await sandbox.commands.run(
    [
      `chmod 700 ${shellQuote(INFISICAL_LOGIN_SCRIPT)}`,
      `tmux new-session -d -s ${shellQuote(INFISICAL_TMUX_SESSION)} ${shellQuote(INFISICAL_LOGIN_SCRIPT)}`,
      `tmux set-option -t ${shellQuote(INFISICAL_TMUX_SESSION)} remain-on-exit on`,
    ].join(" && "),
    { user: "user", timeoutMs: 30_000 },
  );
}

async function waitForLoginUrl(sandbox: SandboxHandle, host: GoatInfisicalHost) {
  const deadline = Date.now() + INFISICAL_LINK_WAIT_MS;
  while (Date.now() < deadline) {
    const output = await captureLoginPane(sandbox);
    const loginUrl = parseInfisicalLoginUrl(output, host);
    if (loginUrl) return loginUrl;
    await delay(250);
  }
  return null;
}

async function waitForBrowserTokenPrompt(sandbox: SandboxHandle) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const output = await captureLoginPane(sandbox);
    if (output.includes("Paste your browser token here:")) return true;
    await delay(250);
  }
  return false;
}

async function captureLoginPane(sandbox: SandboxHandle) {
  const result = await sandbox.commands.run(
    `tmux capture-pane -p -J -S -200 -t ${shellQuote(INFISICAL_TMUX_SESSION)} 2>/dev/null || true`,
    { user: "user", timeoutMs: 10_000 },
  );
  return result.stdout;
}

async function submitBrowserToken(sandbox: SandboxHandle, browserToken: string) {
  await sandbox.files.write(INFISICAL_BROWSER_TOKEN_PATH, browserToken.trim(), { user: "user" });
  try {
    await sandbox.commands.run(
      [
        `chmod 600 ${shellQuote(INFISICAL_BROWSER_TOKEN_PATH)}`,
        `tmux load-buffer -b infisical-browser-token ${shellQuote(INFISICAL_BROWSER_TOKEN_PATH)}`,
        `rm -f ${shellQuote(INFISICAL_BROWSER_TOKEN_PATH)}`,
        `tmux paste-buffer -b infisical-browser-token -t ${shellQuote(INFISICAL_TMUX_SESSION)}`,
        `tmux send-keys -t ${shellQuote(INFISICAL_TMUX_SESSION)} Enter`,
        "tmux delete-buffer -b infisical-browser-token",
      ].join(" && "),
      { user: "user", timeoutMs: 30_000 },
    );
  } finally {
    await sandbox.commands
      .run(`rm -f ${shellQuote(INFISICAL_BROWSER_TOKEN_PATH)}`, {
        user: "user",
        timeoutMs: 10_000,
      })
      .catch(() => undefined);
  }
}

async function waitForLoginExit(sandbox: SandboxHandle) {
  const deadline = Date.now() + INFISICAL_LOGIN_COMPLETION_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const value = await sandbox.files.read(INFISICAL_LOGIN_EXIT);
      const exitCode = Number(sandboxFileText(value).trim());
      if (Number.isInteger(exitCode)) return exitCode;
    } catch {
      // The login process has not finished yet.
    }
    await delay(500);
  }
  throw new Error("Infisical authentication timed out.");
}

async function validateInfisicalLogin(sandbox: SandboxHandle, host: GoatInfisicalHost) {
  const result = await sandbox.commands.run("HOME=/home/user infisical login status --json", {
    user: "user",
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error("Infisical could not validate the saved login.");

  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("Infisical returned an invalid login status.");
  }
  const sessions =
    value && typeof value === "object" && Array.isArray((value as { sessions?: unknown }).sessions)
      ? (value as { sessions: unknown[] }).sessions
      : [];
  const session = sessions.find((candidate): candidate is Record<string, unknown> =>
    Boolean(
      candidate &&
        typeof candidate === "object" &&
        (candidate as Record<string, unknown>).principalType === "user" &&
        (candidate as Record<string, unknown>).status === "authenticated" &&
        isGoatInfisicalSessionDomain((candidate as Record<string, unknown>).domain, host),
    ),
  );
  const email = typeof session?.email === "string" ? session.email.trim() : "";
  if (!email) throw new Error("Infisical did not return the authenticated account.");
  const token = session?.token;
  const exp =
    token && typeof token === "object" && typeof (token as Record<string, unknown>).exp === "number"
      ? (token as Record<string, number>).exp
      : null;
  return { email, expiresAt: exp ? new Date(exp * 1000) : null };
}

async function captureInfisicalAuthBundle(
  sandbox: SandboxHandle,
  initialRedactionValues: string[],
): Promise<GoatInfisicalAuthBundle> {
  const configContents = sandboxFileText(await sandbox.files.read(INFISICAL_CONFIG_PATH));
  const listing = await sandbox.commands.run(
    `find ${shellQuote(INFISICAL_KEYRING_ROOT)} -mindepth 1 -maxdepth 1 -type f -printf '%f\\n'`,
    { user: "user", timeoutMs: 10_000 },
  );
  const keyringNames = listing.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  if (
    keyringNames.length === 0 ||
    keyringNames.length > INFISICAL_KEYRING_MAX_FILES ||
    keyringNames.some((name) => !/^[A-Za-z0-9@._%+\-=]+$/.test(name))
  ) {
    throw new Error("Infisical produced an unexpected file-vault layout.");
  }

  const files = [
    {
      path: ".infisical/infisical-config.json",
      contentsBase64: Buffer.from(configContents, "utf8").toString("base64"),
      mode: 0o600,
    },
  ];
  const redactionValues = new Set(initialRedactionValues.filter(Boolean));
  redactionValues.add(configContents);
  let totalBytes = Buffer.byteLength(configContents);
  for (const name of keyringNames) {
    const contents = sandboxFileText(await sandbox.files.read(`${INFISICAL_KEYRING_ROOT}/${name}`));
    totalBytes += Buffer.byteLength(contents);
    redactionValues.add(contents);
    files.push({
      path: `infisical-keyring/${name}`,
      contentsBase64: Buffer.from(contents, "utf8").toString("base64"),
      mode: 0o600,
    });
  }
  if (totalBytes > INFISICAL_BUNDLE_MAX_BYTES) {
    throw new Error("Infisical produced an unexpectedly large authentication bundle.");
  }
  return {
    formatVersion: GOAT_INFISICAL_AUTH_BUNDLE_FORMAT_VERSION,
    files,
    redactionValues: [...redactionValues],
  };
}

async function loadFlow(workspaceId: string, requestedByWorkosId: string, flowId: string) {
  const [flow] = await getDb()
    .select()
    .from(goatInfisicalAuthFlows)
    .where(
      and(
        eq(goatInfisicalAuthFlows.workspaceId, workspaceId),
        eq(goatInfisicalAuthFlows.requestedByWorkosId, requestedByWorkosId),
        eq(goatInfisicalAuthFlows.id, flowId),
      ),
    )
    .limit(1);
  return flow ?? null;
}

async function markFlowTerminal(input: {
  workspaceId: string;
  flowId: string;
  status: "completed" | "failed" | "expired";
  statusReason: string | null;
  now: Date;
}) {
  await getDb()
    .update(goatInfisicalAuthFlows)
    .set({ status: input.status, statusReason: input.statusReason, updatedAt: input.now })
    .where(
      and(
        eq(goatInfisicalAuthFlows.workspaceId, input.workspaceId),
        eq(goatInfisicalAuthFlows.id, input.flowId),
      ),
    );
}

function flowStatus(flow: typeof goatInfisicalAuthFlows.$inferSelect): InfisicalAuthFlowStatus {
  return {
    id: flow.id,
    status: flow.status,
    loginUrl: flow.loginUrl,
    statusReason: flow.statusReason,
    expiresAt: flow.expiresAt.toISOString(),
  };
}

function isTerminalStatus(status: string) {
  return status === "completed" || status === "failed" || status === "expired";
}

function safeCompletionError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Infisical ") || message.startsWith("That does not look")) {
    return message.slice(0, 240);
  }
  return "Infisical authentication could not be completed. Start a new connection.";
}

function sandboxFileText(value: string | Uint8Array) {
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
