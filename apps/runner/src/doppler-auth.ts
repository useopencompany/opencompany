import { randomUUID } from "node:crypto";
import { shellQuote } from "@opencompany/agent-runtime";
import { DEFAULT_SANDBOX_SIZE } from "@opencompany/core/sandbox-sizes";
import {
  disconnectDopplerConnection,
  hasDopplerPlugin as installedDopplerPlugin,
  saveDopplerConnection,
} from "@opencompany/db/doppler-auth";
import { dopplerAuthFlows } from "@opencompany/db/product-schema";
import { getWorkspaceRole } from "@opencompany/db/workspaces";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Sandbox } from "e2b";
import { codingSandboxTemplate } from "./coding-sandbox-lifecycle";
import { getDb } from "./db";
import { validateDopplerToken } from "./doppler-api";
import { DOPPLER_CLI_VERSION, DOPPLER_INSTALL_COMMAND } from "./doppler-version";
import type { RunnerEnv } from "./env";
import { killSandbox, managedSandboxMetadata, type SandboxHandle } from "./sandbox";

const AUTH_HOME = "/home/user/.opencompany/doppler-auth";
const LOGIN_LOG = `${AUTH_HOME}/login.log`;
const LOGIN_EXIT = `${AUTH_HOME}/login.exit`;
const TTL = 5 * 60_000;
export type DopplerActor = { workspaceId: string; requestedByWorkosId: string };
export type DopplerAuthFlow = {
  id: string;
  status: "pending" | "link_ready" | "completed" | "failed" | "expired";
  loginUrl: string | null;
  userCode: string | null;
  statusReason: string | null;
  expiresAt: string;
};

export async function hasDopplerPlugin(workspaceId: string, userId: string) {
  return installedDopplerPlugin({ db: getDb(), workspaceId, userId });
}

async function requireMember(input: DopplerActor) {
  if (
    !(await getWorkspaceRole(
      { workspaceId: input.workspaceId, userWorkosId: input.requestedByWorkosId },
      { db: getDb() },
    ))
  ) {
    throw new Error("Workspace membership is required to connect Doppler.");
  }
}

// Serialize completion, cancellation, disconnect and replacement for this personal connection.
async function connectionLock<T>(
  input: DopplerActor,
  fn: (tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0]) => Promise<T>,
) {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["doppler", input.workspaceId, input.requestedByWorkosId])}, 0))`,
    );
    return fn(tx);
  });
}

export async function ensureDopplerInstalled(sandbox: SandboxHandle) {
  const check = await sandbox.commands.run("doppler --version 2>/dev/null || true", {
    user: "user",
    timeoutMs: 30_000,
  });
  if (check.stdout.trim() !== `v${DOPPLER_CLI_VERSION}`) {
    await sandbox.commands.run(DOPPLER_INSTALL_COMMAND, { user: "root", timeoutMs: 180_000 });
  }
}

export function parseDopplerLogin(output: string) {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const url = plain.match(/Complete authorization at (https:\/\/[^\s]+)/)?.[1];
  const userCode = plain.match(/Your auth code is:\s*([A-Za-z0-9_-]{8,256})/)?.[1];
  if (!url || !userCode) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.origin !== "https://dashboard.doppler.com" ||
      parsed.pathname !== "/workplace/auth/cli" ||
      parsed.username ||
      parsed.password
    )
      return null;
    return { loginUrl: parsed.toString(), userCode };
  } catch {
    return null;
  }
}

export async function readDopplerFile(sandbox: SandboxHandle, path: string) {
  // The command always returns success for an absent file. Transport errors still propagate.
  const result = await sandbox.commands.run(
    `if test -f ${shellQuote(path)}; then cat ${shellQuote(path)}; fi`,
    {
      user: "user",
      timeoutMs: 15_000,
    },
  );
  return result.stdout;
}

export async function startDopplerAuthFlow(
  input: DopplerActor & { env: RunnerEnv },
): Promise<DopplerAuthFlow> {
  await requireMember(input);
  if (!(await hasDopplerPlugin(input.workspaceId, input.requestedByWorkosId)))
    throw new Error("Install the Doppler plugin before connecting.");
  const id = `gdopf_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const expiresAt = new Date(Date.now() + TTL);
  const stale = await connectionLock(input, async (tx) => {
    const old = await tx
      .update(dopplerAuthFlows)
      .set({
        status: "failed",
        userCode: null,
        statusReason: "Replaced by a new connection.",
        updatedAt: new Date(),
      })
      .where(and(owner(input), inArray(dopplerAuthFlows.status, ["pending", "link_ready"])))
      .returning({ sandboxId: dopplerAuthFlows.sandboxId });
    await tx.insert(dopplerAuthFlows).values({
      id,
      workspaceId: input.workspaceId,
      requestedByWorkosId: input.requestedByWorkosId,
      sandboxId: "",
      expiresAt,
      status: "pending",
    });
    return old;
  });
  await Promise.all(
    stale
      .filter((row) => row.sandboxId)
      .map((row) => killSandbox(row.sandboxId).catch(() => undefined)),
  );
  let sandbox: SandboxHandle | undefined;
  try {
    sandbox = await Sandbox.create(
      codingSandboxTemplate(input.env.codexE2bTemplates, DEFAULT_SANDBOX_SIZE),
      {
        timeoutMs: TTL + 60_000,
        lifecycle: { onTimeout: "kill" },
        metadata: managedSandboxMetadata({
          namespace: input.env.sandboxNamespace,
          ownerKind: "doppler_auth_flow",
          ownerId: id,
          metadata: { workspace_id: input.workspaceId, user_id: input.requestedByWorkosId },
        }),
      },
    );
    const [attached] = await getDb()
      .update(dopplerAuthFlows)
      .set({ sandboxId: sandbox.sandboxId })
      .where(and(owner(input), eq(dopplerAuthFlows.id, id), eq(dopplerAuthFlows.status, "pending")))
      .returning({ id: dopplerAuthFlows.id });
    if (!attached) throw new Error("Connection cancelled.");
    await ensureDopplerInstalled(sandbox);
    await sandbox.commands.run(`mkdir -p '${AUTH_HOME}' && chmod 700 '${AUTH_HOME}'`, {
      user: "user",
      timeoutMs: 15_000,
    });
    await sandbox.commands.run(
      `umask 077; (doppler --no-read-env --no-check-version --config-dir '${AUTH_HOME}/config' login --yes --no-copy --scope / > '${LOGIN_LOG}' 2>&1; echo $? > '${LOGIN_EXIT}')`,
      { user: "user", background: true, timeoutMs: TTL },
    );
    let details: ReturnType<typeof parseDopplerLogin> = null;
    for (let i = 0; i < 20; i++) {
      details = parseDopplerLogin(await readDopplerFile(sandbox, LOGIN_LOG));
      if (details) break;
      if ((await readDopplerFile(sandbox, LOGIN_EXIT)).trim())
        throw new Error("Doppler login failed to start.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!details) throw new Error("Doppler did not return a sign-in code.");
    const [ready] = await getDb()
      .update(dopplerAuthFlows)
      .set({ ...details, status: "link_ready", updatedAt: new Date() })
      .where(and(owner(input), eq(dopplerAuthFlows.id, id), eq(dopplerAuthFlows.status, "pending")))
      .returning({ id: dopplerAuthFlows.id });
    if (!ready) throw new Error("Connection cancelled.");
    return {
      id,
      ...details,
      status: "link_ready",
      statusReason: null,
      expiresAt: expiresAt.toISOString(),
    };
  } catch {
    await getDb()
      .update(dopplerAuthFlows)
      .set({
        status: "failed",
        userCode: null,
        statusReason: "Doppler sign-in could not start.",
        updatedAt: new Date(),
      })
      .where(
        and(
          owner(input),
          eq(dopplerAuthFlows.id, id),
          inArray(dopplerAuthFlows.status, ["pending", "link_ready"]),
        ),
      );
    if (sandbox) await killSandbox(sandbox.sandboxId).catch(() => undefined);
    throw new Error("Doppler connection could not start. Please try again.");
  }
}

function owner(input: DopplerActor) {
  return and(
    eq(dopplerAuthFlows.workspaceId, input.workspaceId),
    eq(dopplerAuthFlows.requestedByWorkosId, input.requestedByWorkosId),
  );
}
function view(row: typeof dopplerAuthFlows.$inferSelect): DopplerAuthFlow {
  return {
    id: row.id,
    status: row.status,
    loginUrl: row.loginUrl,
    userCode: row.userCode,
    statusReason: row.statusReason,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function pollDopplerAuthFlow(
  input: DopplerActor & { flowId: string },
): Promise<DopplerAuthFlow | null> {
  await requireMember(input);
  const [flow] = await getDb()
    .select()
    .from(dopplerAuthFlows)
    .where(and(owner(input), eq(dopplerAuthFlows.id, input.flowId)))
    .limit(1);
  if (!flow) return null;
  if (flow.status !== "pending" && flow.status !== "link_ready") return view(flow);
  let token: string | null = null;
  let accountName = "";
  let status: "completed" | "failed" | "expired" = "failed";
  let reason: string | null = "Doppler authentication failed. Start a new connection.";
  if (flow.expiresAt <= new Date()) {
    status = "expired";
    reason = "Doppler sign-in expired. Start a new connection.";
  } else {
    try {
      const sandbox = await Sandbox.connect(flow.sandboxId, { requestTimeoutMs: 15_000 });
      const exit = (await readDopplerFile(sandbox, LOGIN_EXIT)).trim();
      if (!exit) return view(flow);
      if (exit === "0") {
        const result = await sandbox.commands.run(
          `doppler --no-read-env --no-check-version --config-dir '${AUTH_HOME}/config' configure get token --plain --scope /`,
          { user: "user", timeoutMs: 15_000 },
        );
        const candidate = result.stdout.trim();
        if (!/^dp\.ct\.[A-Za-z0-9_-]+$/.test(candidate) || candidate.length >= 4096)
          throw new Error("Unexpected credential format.");
        accountName = await validateDopplerToken(candidate);
        token = candidate;
        status = "completed";
        reason = null;
      }
    } catch {
      /* Report a fixed error, never provider output or credentials. */
    }
  }
  try {
    return await connectionLock(input, async (tx) => {
      const [current] = await tx
        .select()
        .from(dopplerAuthFlows)
        .where(and(owner(input), eq(dopplerAuthFlows.id, input.flowId)))
        .limit(1);
      if (!current) return null;
      if (current.status !== "pending" && current.status !== "link_ready") return view(current);
      if (
        !(await installedDopplerPlugin({
          db: tx,
          workspaceId: input.workspaceId,
          userId: input.requestedByWorkosId,
        }))
      ) {
        status = "failed";
        reason = "The Doppler plugin is no longer enabled.";
      }
      if (status === "completed" && token) {
        await saveDopplerConnection({
          db: tx,
          workspaceId: input.workspaceId,
          userId: input.requestedByWorkosId,
          authBundle: { formatVersion: 1, token },
          accountName,
          cliVersion: DOPPLER_CLI_VERSION,
          connectedByWorkosId: input.requestedByWorkosId,
        });
      }
      await tx
        .update(dopplerAuthFlows)
        .set({ status, statusReason: reason, userCode: null, updatedAt: new Date() })
        .where(eq(dopplerAuthFlows.id, flow.id));
      return { ...view(current), status, userCode: null, statusReason: reason };
    });
  } finally {
    await killSandbox(flow.sandboxId).catch(() => undefined);
  }
}

export async function cancelDopplerAuth(input: DopplerActor & { disconnect: boolean }) {
  await requireMember(input);
  const flows = await connectionLock(input, async (tx) => {
    const rows = await tx
      .update(dopplerAuthFlows)
      .set({
        status: "failed",
        userCode: null,
        statusReason: "Connection cancelled.",
        updatedAt: new Date(),
      })
      .where(and(owner(input), inArray(dopplerAuthFlows.status, ["pending", "link_ready"])))
      .returning({ sandboxId: dopplerAuthFlows.sandboxId });
    if (input.disconnect)
      await disconnectDopplerConnection({
        db: tx,
        workspaceId: input.workspaceId,
        userId: input.requestedByWorkosId,
      });
    return rows;
  });
  await Promise.all(
    flows
      .filter((row) => row.sandboxId)
      .map((row) => killSandbox(row.sandboxId).catch(() => undefined)),
  );
}
