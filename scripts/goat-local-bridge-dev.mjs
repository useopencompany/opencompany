// Called by: @opencompany/goat-local-bridge `bun run dev`.
// Purpose: in Goat dev, create/reuse a local bridge token and run the bridge
// after the Next app is reachable, so `bun run dev:goat` is one command.

import "./load-env.mjs";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bridgeCwd = join(repoRoot, "apps", "goat-local-bridge");
const tokenFilePath = join(repoRoot, ".context", "goat-local-bridge", "dev-token.json");

const TOKEN_PREFIX = "oc_goat_local_";
const TOKEN_FILE_SCHEMA = "goat.local_bridge.dev_token.v1";
const DEFAULT_BASE_URL = `http://127.0.0.1:${process.env.GOAT_PORT?.trim() || "3002"}`;
const BASE_URL = (process.env.GOAT_LOCAL_BRIDGE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
  /\/+$/,
  "",
);
const PROJECTS_DIR =
  process.env.GOAT_LOCAL_PROJECTS_DIR?.trim() ||
  join(homedir(), ".opencompany", "goat", "projects");
const BRIDGE_NAME = process.env.GOAT_LOCAL_BRIDGE_NAME?.trim() || "Local Mac (dev)";
const MODEL = process.env.GOAT_LOCAL_BRIDGE_MODEL?.trim() || "gpt-5.5";
const DISABLED = process.env.GOAT_LOCAL_BRIDGE_DISABLED === "1";
const RETRY_MS = 2_000;
const USER_WAIT_MS = 3_000;
const APP_WAIT_MS = 1_000;

let bridgeProcess = null;
let shuttingDown = false;
let lastWaitMessage = null;

installSignalHandlers();

if (DISABLED) {
  console.log("[goat-local-bridge-dev] disabled by GOAT_LOCAL_BRIDGE_DISABLED=1.");
  await sleepForever();
} else {
  await main();
}

async function main() {
  console.log(`[goat-local-bridge-dev] launcher enabled for ${BASE_URL}`);
  await mkdir(PROJECTS_DIR, { recursive: true });
  console.log(`[goat-local-bridge-dev] local projects dir ${PROJECTS_DIR}`);
  while (!shuttingDown) {
    try {
      const databaseUrl = process.env.DATABASE_URL?.trim();
      if (!databaseUrl) {
        await wait("Waiting for DATABASE_URL before starting the local bridge.", RETRY_MS);
        continue;
      }

      const sql = neon(databaseUrl);
      const user = await waitForGoatUser(sql);
      if (!user || shuttingDown) continue;

      const token = await ensureDevBridgeToken(sql, {
        databaseUrl,
        userWorkosId: user.workos_user_id,
        userLabel: user.email || user.workos_user_id,
      });
      await waitForGoatApp();
      if (shuttingDown) break;

      await runBridge(token);
      if (!shuttingDown) await sleep(RETRY_MS);
    } catch (error) {
      console.error(`[goat-local-bridge-dev] ${errorMessage(error)}`);
      await sleep(RETRY_MS);
    }
  }
}

async function waitForGoatUser(sql) {
  while (!shuttingDown) {
    try {
      const configuredUser = process.env.GOAT_LOCAL_BRIDGE_USER_WORKOS_ID?.trim();
      const rows = configuredUser
        ? await sql`
            SELECT workos_user_id, email, local_codex_beta_enabled
            FROM goat.users
            WHERE workos_user_id = ${configuredUser}
            LIMIT 1
          `
        : await sql`
            SELECT workos_user_id, email, local_codex_beta_enabled
            FROM goat.users
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
          `;
      const user = rows[0];
      if (user) {
        if (user.local_codex_beta_enabled !== true) {
          await wait(
            `Waiting for Local Codex beta to be enabled in Goat Settings for ${user.email || user.workos_user_id}.`,
            USER_WAIT_MS,
          );
          continue;
        }
        lastWaitMessage = null;
        return user;
      }
      const message = configuredUser
        ? `Waiting for Goat user ${configuredUser}. Sign in locally once to create it.`
        : "Waiting for a Goat user. Open Goat and sign in once to create one.";
      await wait(message, USER_WAIT_MS);
    } catch (error) {
      await wait(`Waiting for Goat local bridge schema: ${errorMessage(error)}`, USER_WAIT_MS);
    }
  }
  return null;
}

async function ensureDevBridgeToken(sql, input) {
  const databaseFingerprint = fingerprintDatabaseUrl(input.databaseUrl);
  const existing = await readTokenFile();
  if (
    existing?.schemaVersion === TOKEN_FILE_SCHEMA &&
    existing.databaseFingerprint === databaseFingerprint &&
    existing.userWorkosId === input.userWorkosId &&
    typeof existing.bridgeId === "string" &&
    typeof existing.token === "string"
  ) {
    const tokenHash = hashToken(existing.token);
    const rows = await sql`
      SELECT id
      FROM goat.local_bridges
      WHERE id = ${existing.bridgeId}
        AND user_workos_id = ${input.userWorkosId}
        AND token_hash = ${tokenHash}
        AND revoked_at IS NULL
      LIMIT 1
    `;
    if (rows[0]) return existing.token;
  }

  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const bridgeId = `goat_local_bridge_dev_${randomUUID()}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.slice(0, TOKEN_PREFIX.length + 6);

  await sql`
    UPDATE goat.local_bridges
    SET revoked_at = now(), updated_at = now()
    WHERE user_workos_id = ${input.userWorkosId}
      AND name = ${BRIDGE_NAME}
      AND revoked_at IS NULL
  `;
  await sql`
    INSERT INTO goat.local_bridges (
      id,
      user_workos_id,
      name,
      token_hash,
      token_prefix,
      created_at,
      updated_at
    )
    VALUES (
      ${bridgeId},
      ${input.userWorkosId},
      ${BRIDGE_NAME},
      ${tokenHash},
      ${tokenPrefix},
      now(),
      now()
    )
  `;

  await mkdir(dirname(tokenFilePath), { recursive: true });
  await writeFile(
    tokenFilePath,
    `${JSON.stringify(
      {
        schemaVersion: TOKEN_FILE_SCHEMA,
        databaseFingerprint,
        userWorkosId: input.userWorkosId,
        bridgeId,
        token,
        tokenPrefix,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(`[goat-local-bridge-dev] paired ${BRIDGE_NAME} for ${input.userLabel}.`);
  return token;
}

async function readTokenFile() {
  try {
    return JSON.parse(await readFile(tokenFilePath, "utf8"));
  } catch {
    return null;
  }
}

async function waitForGoatApp() {
  while (!shuttingDown) {
    try {
      const response = await fetchWithTimeout(`${BASE_URL}/api/healthz`, 1_500);
      if (response.ok) {
        lastWaitMessage = null;
        return;
      }
      await wait(`Waiting for Goat app at ${BASE_URL} (${response.status}).`, APP_WAIT_MS);
    } catch {
      await wait(`Waiting for Goat app at ${BASE_URL}.`, APP_WAIT_MS);
    }
  }
}

async function runBridge(token) {
  return new Promise((resolve) => {
    bridgeProcess = spawn(
      "bun",
      [
        "run",
        "src/index.ts",
        "--base-url",
        BASE_URL,
        "--token",
        token,
        "--model",
        MODEL,
        "--name",
        BRIDGE_NAME,
      ],
      {
        cwd: bridgeCwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    prefixStream(bridgeProcess.stdout, "stdout");
    prefixStream(bridgeProcess.stderr, "stderr");
    bridgeProcess.on("error", (error) => {
      console.error(`[goat-local-bridge-dev] failed to start bridge: ${error.message}`);
    });
    bridgeProcess.on("exit", (code, signal) => {
      bridgeProcess = null;
      if (!shuttingDown) {
        console.warn(
          `[goat-local-bridge-dev] bridge exited (${signal ?? code ?? "unknown"}); restarting soon.`,
        );
      }
      resolve();
    });
  });
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function wait(message, ms) {
  if (message !== lastWaitMessage) {
    console.log(`[goat-local-bridge-dev] ${message}`);
    lastWaitMessage = message;
  }
  await sleep(ms);
}

function prefixStream(stream, source) {
  stream.setEncoding("utf8");
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) console.log(`[goat-local-bridge:${source}] ${line}`);
    }
  });
  stream.on("end", () => {
    if (buffered.trim()) console.log(`[goat-local-bridge:${source}] ${buffered}`);
  });
}

function installSignalHandlers() {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      shuttingDown = true;
      if (bridgeProcess && !bridgeProcess.killed) bridgeProcess.kill("SIGTERM");
      setTimeout(() => process.exit(0), 50).unref();
    });
  }
}

function fingerprintDatabaseUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "unknown";
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepForever() {
  return new Promise(() => {});
}
