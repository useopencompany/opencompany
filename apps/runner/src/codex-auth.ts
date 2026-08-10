import { shellQuote } from "@opencompany/agent-runtime";
import {
  newGoatCodexDeviceAuthFlowId,
  saveGoatCodexCredential,
} from "@opencompany/db/goat-codex-auth";
import { goatCodexDeviceAuthFlows } from "@opencompany/db/goat-schema";
import { createLogger } from "@opencompany/observability";
import { and, eq, inArray } from "drizzle-orm";
import { Sandbox } from "e2b";
import { ensureCodexInstalled } from "./codex-cli";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { killSandbox, type SandboxHandle } from "./sandbox";

const logger = createLogger({ service: "opencompany-runner", runtime: "codex-auth" });

const CODEX_AUTH_HOME = "/home/user/.opencompany/codex-device-auth";
const CODEX_LOGIN_LOG = `${CODEX_AUTH_HOME}/codex-login.log`;
const CODEX_LOGIN_EXIT = `${CODEX_AUTH_HOME}/codex-login.exit`;
const CODEX_LOGIN_PID = `${CODEX_AUTH_HOME}/codex-login.pid`;
const CODEX_AUTH_JSON = `${CODEX_AUTH_HOME}/auth.json`;
const CODEX_AUTH_FLOW_TTL_MS = 15 * 60 * 1000;
const CODEX_AUTH_SANDBOX_TIMEOUT_MS = 20 * 60 * 1000;
const CODEX_BIN_PATH = '"$HOME/.codex/bin"';

export type CodexDeviceAuthFlowStatus = {
  id: string;
  status: "pending" | "code_ready" | "completed" | "failed" | "expired";
  userCode: string | null;
  verificationUri: string | null;
  statusReason: string | null;
  expiresAt: string;
};

export async function startGoatCodexDeviceAuthFlow(input: {
  userWorkosId: string;
  env: RunnerEnv;
}): Promise<CodexDeviceAuthFlowStatus> {
  await supersedeActiveGoatCodexAuthFlows(input.userWorkosId);
  const sandbox = await createCodexAuthSandbox({
    ownerLogFields: { user_workos_id: input.userWorkosId },
    metadata: {
      user_id: input.userWorkosId,
    },
    template: input.env.codexE2bTemplate ?? "codex",
  });

  try {
    await prepareCodexAuthHome(sandbox);
    await spawnCodexDeviceLogin(sandbox);

    const id = newGoatCodexDeviceAuthFlowId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CODEX_AUTH_FLOW_TTL_MS);

    await getDb().insert(goatCodexDeviceAuthFlows).values({
      id,
      userWorkosId: input.userWorkosId,
      sandboxId: sandbox.sandboxId,
      userCode: null,
      verificationUri: null,
      status: "pending",
      statusReason: "Waiting for Codex to print a device login code.",
      expiresAt,
      updatedAt: now,
    });
    logger.info("Stored pending Goat Codex auth flow", {
      event: "opencompany.runner_goat_codex_auth_flow_stored",
      user_workos_id: input.userWorkosId,
      flow_id: id,
      sandbox_id: sandbox.sandboxId,
      expires_at: expiresAt.toISOString(),
    });

    return {
      id,
      status: "pending",
      userCode: null,
      verificationUri: null,
      statusReason: "Waiting for Codex to print a device login code.",
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    logger.warn("Goat Codex auth flow start failed", {
      event: "opencompany.runner_goat_codex_auth_start_failed",
      user_workos_id: input.userWorkosId,
      sandbox_id: sandbox.sandboxId,
      error,
    });
    await killSandbox(sandbox.sandboxId).catch(() => {});
    throw error;
  }
}

async function supersedeActiveGoatCodexAuthFlows(userWorkosId: string) {
  const activeFlows = await getDb()
    .select({
      id: goatCodexDeviceAuthFlows.id,
      sandboxId: goatCodexDeviceAuthFlows.sandboxId,
    })
    .from(goatCodexDeviceAuthFlows)
    .where(
      and(
        eq(goatCodexDeviceAuthFlows.userWorkosId, userWorkosId),
        inArray(goatCodexDeviceAuthFlows.status, ["pending", "code_ready"]),
      ),
    );

  if (activeFlows.length === 0) return;

  const now = new Date();
  for (const flow of activeFlows) {
    await markGoatFlowTerminal({
      userWorkosId,
      flowId: flow.id,
      status: "failed",
      statusReason: "Superseded by a new Codex device authentication attempt.",
      now,
    });
    await killSandbox(flow.sandboxId).catch(() => {});
  }
  logger.info("Superseded active Goat Codex auth flows", {
    event: "opencompany.runner_goat_codex_auth_flows_superseded",
    user_workos_id: userWorkosId,
    flow_count: activeFlows.length,
  });
}

export async function pollGoatCodexDeviceAuthFlow(input: {
  userWorkosId: string;
  flowId: string;
  env: RunnerEnv;
}): Promise<CodexDeviceAuthFlowStatus | null> {
  const flow = await loadGoatFlow(input.userWorkosId, input.flowId);
  if (!flow) {
    logger.warn("Goat Codex auth flow not found during poll", {
      event: "opencompany.runner_goat_codex_auth_poll_not_found",
      user_workos_id: input.userWorkosId,
      flow_id: input.flowId,
    });
    return null;
  }

  if (flow.status === "completed" || flow.status === "failed" || flow.status === "expired") {
    return goatFlowStatus(flow);
  }

  const now = new Date();
  if (flow.expiresAt <= now) {
    await markGoatFlowTerminal({
      userWorkosId: input.userWorkosId,
      flowId: input.flowId,
      status: "expired",
      statusReason: "Codex device authentication expired. Start a new connection.",
      now,
    });
    await killSandbox(flow.sandboxId).catch(() => {});
    return {
      ...goatFlowStatus(flow),
      status: "expired",
      statusReason: "Codex device authentication expired. Start a new connection.",
    };
  }

  let sandbox: SandboxHandle;
  try {
    sandbox = await Sandbox.connect(flow.sandboxId, {
      timeoutMs: CODEX_AUTH_SANDBOX_TIMEOUT_MS,
      requestTimeoutMs: 30_000,
    });
  } catch (error) {
    await markGoatFlowTerminal({
      userWorkosId: input.userWorkosId,
      flowId: input.flowId,
      status: "failed",
      statusReason: "Codex authentication sandbox is no longer available.",
      now,
    });
    logger.warn("Goat Codex auth sandbox connect failed", {
      event: "opencompany.runner_goat_codex_auth_sandbox_connect_failed",
      user_workos_id: input.userWorkosId,
      flow_id: input.flowId,
      sandbox_id: flow.sandboxId,
      error,
    });
    return {
      ...goatFlowStatus(flow),
      status: "failed",
      statusReason: "Codex authentication sandbox is no longer available.",
    };
  }

  const login = await readDeviceLoginDetails(sandbox);
  if (login.browserAuthFallback && !login.userCode) {
    const reason =
      "Codex fell back to browser OAuth instead of device-code login. Enable device code login in ChatGPT security or workspace permissions, then retry.";
    await markGoatFlowTerminal({
      userWorkosId: input.userWorkosId,
      flowId: input.flowId,
      status: "failed",
      statusReason: reason,
      now,
    });
    await killSandbox(flow.sandboxId).catch(() => {});
    return { ...goatFlowStatus(flow), status: "failed", statusReason: reason };
  }

  const authJson = await readAuthJson(sandbox);
  if (authJson) {
    try {
      await validateCodexAuth(sandbox);
      await saveGoatCodexCredential({
        db: getDb(),
        userWorkosId: input.userWorkosId,
        authJson,
        validatedAt: now,
        now,
      });
      await markGoatFlowTerminal({
        userWorkosId: input.userWorkosId,
        flowId: input.flowId,
        status: "completed",
        statusReason: null,
        now,
      });
      await killSandbox(flow.sandboxId).catch(() => {});
      logger.info("Goat Codex auth flow completed", {
        event: "opencompany.runner_goat_codex_auth_flow_completed",
        user_workos_id: input.userWorkosId,
        flow_id: input.flowId,
        sandbox_id: flow.sandboxId,
      });
      return {
        ...goatFlowStatus(flow),
        status: "completed",
        userCode: login.userCode ?? flow.userCode,
        verificationUri: login.verificationUri ?? flow.verificationUri,
        statusReason: null,
      };
    } catch (error) {
      await markGoatFlowTerminal({
        userWorkosId: input.userWorkosId,
        flowId: input.flowId,
        status: "failed",
        statusReason: "Codex login completed, but the saved credentials could not be validated.",
        now,
      });
      await killSandbox(flow.sandboxId).catch(() => {});
      logger.warn("Goat Codex auth validation failed", {
        event: "opencompany.runner_goat_codex_auth_validation_failed",
        user_workos_id: input.userWorkosId,
        flow_id: input.flowId,
        error,
      });
      return {
        ...goatFlowStatus(flow),
        status: "failed",
        statusReason: "Codex login completed, but the saved credentials could not be validated.",
      };
    }
  }

  const exitCode = await readLoginExitCode(sandbox);
  if (exitCode && exitCode !== "0") {
    const reason = "Codex device authentication failed before credentials were saved.";
    await markGoatFlowTerminal({
      userWorkosId: input.userWorkosId,
      flowId: input.flowId,
      status: "failed",
      statusReason: reason,
      now,
    });
    await killSandbox(flow.sandboxId).catch(() => {});
    return { ...goatFlowStatus(flow), status: "failed", statusReason: reason };
  }

  const nextUserCode = login.userCode ?? flow.userCode;
  const nextVerificationUri = login.verificationUri ?? flow.verificationUri;
  const nextStatus = nextUserCode && nextVerificationUri ? "code_ready" : flow.status;
  const nextStatusReason =
    nextStatus === "code_ready" ? null : "Waiting for Codex to print a device login code.";
  const shouldUpdateFlow =
    nextUserCode !== flow.userCode ||
    nextVerificationUri !== flow.verificationUri ||
    nextStatus !== flow.status ||
    nextStatusReason !== flow.statusReason;

  if (shouldUpdateFlow) {
    const [updated] = await getDb()
      .update(goatCodexDeviceAuthFlows)
      .set({
        userCode: nextUserCode,
        verificationUri: nextVerificationUri,
        status: nextStatus,
        statusReason: nextStatusReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(goatCodexDeviceAuthFlows.userWorkosId, input.userWorkosId),
          eq(goatCodexDeviceAuthFlows.id, input.flowId),
        ),
      )
      .returning();
    if (updated) return goatFlowStatus(updated);
  }

  return goatFlowStatus(flow);
}

async function createCodexAuthSandbox(input: {
  template: string;
  metadata?: Record<string, string> | undefined;
  ownerLogFields: Record<string, string | number | boolean | null>;
}) {
  logger.debug("Creating Codex auth sandbox", {
    event: "opencompany.runner_codex_auth_sandbox_create_started",
    template: input.template,
    ...input.ownerLogFields,
  });
  const sandbox = await Sandbox.create(input.template, {
    envs: {},
    ...(input.metadata ? { metadata: input.metadata } : {}),
    timeoutMs: CODEX_AUTH_SANDBOX_TIMEOUT_MS,
    lifecycle: { onTimeout: "kill" },
  });
  logger.info("Codex auth sandbox created", {
    event: "opencompany.runner_codex_auth_sandbox_created",
    sandbox_id: sandbox.sandboxId,
    ...input.ownerLogFields,
  });
  await sandbox.setTimeout(CODEX_AUTH_SANDBOX_TIMEOUT_MS);
  return sandbox;
}

async function prepareCodexAuthHome(sandbox: SandboxHandle) {
  await sandbox.commands.run(`mkdir -p ${shellQuote(CODEX_AUTH_HOME)}`, { timeoutMs: 30_000 });
  await sandbox.files.write(
    `${CODEX_AUTH_HOME}/config.toml`,
    [
      'cli_auth_credentials_store = "file"',
      'forced_login_method = "chatgpt"',
      "",
      "[sandbox_workspace_write]",
      "network_access = true",
      "",
    ].join("\n"),
  );
}

async function spawnCodexDeviceLogin(sandbox: SandboxHandle) {
  const clearState = `rm -f ${shellQuote(CODEX_LOGIN_LOG)} ${shellQuote(
    CODEX_LOGIN_EXIT,
  )} ${shellQuote(CODEX_LOGIN_PID)}`;
  await sandbox.commands.run(clearState, { timeoutMs: 30_000 });
  await ensureCodexInstalled(sandbox);
  const backgroundTask = `cd ${shellQuote(
    CODEX_AUTH_HOME,
  )} && export PATH=${CODEX_BIN_PATH}:"$PATH" && ((CODEX_HOME=${shellQuote(
    CODEX_AUTH_HOME,
  )} codex login --device-auth) > ${shellQuote(CODEX_LOGIN_LOG)} 2>&1; echo $? > ${shellQuote(
    CODEX_LOGIN_EXIT,
  )})`;
  const handle = await sandbox.commands.run(backgroundTask, {
    background: true,
    timeoutMs: CODEX_AUTH_SANDBOX_TIMEOUT_MS,
  });
  await sandbox.files.write(CODEX_LOGIN_PID, String(handle.pid));
  logger.debug("Codex device login command started in background", {
    event: "opencompany.runner_codex_auth_login_background_started",
    sandbox_id: sandbox.sandboxId,
    command_pid: handle.pid,
  });
}

async function readDeviceLoginDetails(sandbox: SandboxHandle) {
  const log = await readSandboxText(sandbox, CODEX_LOGIN_LOG);
  return parseDeviceLoginDetails(log ?? "");
}

export function parseDeviceLoginDetails(text: string) {
  const plainText = stripAnsi(text);
  const urls = (plainText.match(/https:\/\/[^\s)]+/g) ?? []).map((url) => url.replace(/[,.]$/, ""));
  const browserAuthFallback = urls.some(isBrowserAuthUrl);
  const verificationUri = urls.find(isDeviceVerificationUrl) ?? null;
  const userCode = parseDeviceUserCode(plainText);
  return { userCode, verificationUri, browserAuthFallback };
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isBrowserAuthUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return (
      path.includes("/oauth/authorize") ||
      parsed.searchParams.has("code_challenge") ||
      parsed.searchParams.get("response_type") === "code"
    );
  } catch {
    return false;
  }
}

function isDeviceVerificationUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return (
      (host.endsWith("chatgpt.com") || host.endsWith("openai.com")) &&
      (path.includes("activate") || path.includes("device"))
    );
  } catch {
    return false;
  }
}

function parseDeviceUserCode(text: string) {
  const hyphenated = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/i)?.[1];
  if (hyphenated) return hyphenated.toUpperCase();

  const labelled = text.match(/\b(?:user\s+)?code\s*:?\s*([A-Z0-9]{6,12})\b/i)?.[1];
  if (!labelled) return null;

  const code = labelled.toUpperCase();
  if (
    ["AUTHORIZATION", "BROWSER", "CHATGPT", "DEVICE", "LOGIN", "OPENAI", "REDIRECT"].includes(code)
  ) {
    return null;
  }
  return code;
}

async function readAuthJson(sandbox: SandboxHandle) {
  const content = await readSandboxText(sandbox, CODEX_AUTH_JSON);
  if (!content?.trim()) return null;
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex auth.json was not an object.");
  }
  return parsed as Record<string, unknown>;
}

async function validateCodexAuth(sandbox: SandboxHandle) {
  await sandbox.commands.run(
    `cd ${shellQuote(CODEX_AUTH_HOME)} && export PATH=${CODEX_BIN_PATH}:"$PATH" && CODEX_HOME=${shellQuote(
      CODEX_AUTH_HOME,
    )} codex login status`,
    { timeoutMs: 30_000 },
  );
}

async function readLoginExitCode(sandbox: SandboxHandle) {
  const content = await readSandboxText(sandbox, CODEX_LOGIN_EXIT);
  return content?.trim() || null;
}

async function readSandboxText(sandbox: SandboxHandle, path: string) {
  try {
    const content = await sandbox.files.read(path);
    return typeof content === "string" ? content : new TextDecoder().decode(content);
  } catch {
    return null;
  }
}

async function loadGoatFlow(userWorkosId: string, flowId: string) {
  const [flow] = await getDb()
    .select()
    .from(goatCodexDeviceAuthFlows)
    .where(
      and(
        eq(goatCodexDeviceAuthFlows.userWorkosId, userWorkosId),
        eq(goatCodexDeviceAuthFlows.id, flowId),
      ),
    )
    .limit(1);
  return flow ?? null;
}

async function markGoatFlowTerminal(input: {
  userWorkosId: string;
  flowId: string;
  status: "completed" | "failed" | "expired";
  statusReason: string | null;
  now: Date;
}) {
  await getDb()
    .update(goatCodexDeviceAuthFlows)
    .set({
      status: input.status,
      statusReason: input.statusReason,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(goatCodexDeviceAuthFlows.userWorkosId, input.userWorkosId),
        eq(goatCodexDeviceAuthFlows.id, input.flowId),
      ),
    );
}

function goatFlowStatus(
  flow: typeof goatCodexDeviceAuthFlows.$inferSelect,
): CodexDeviceAuthFlowStatus {
  return {
    id: flow.id,
    status: flow.status,
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    statusReason: flow.statusReason,
    expiresAt: flow.expiresAt.toISOString(),
  };
}
