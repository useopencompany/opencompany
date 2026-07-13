// Called by: scripts/dev.mjs and scripts/github-tunnel.mjs.
// Purpose: shared ngrok startup, URL detection, and tunnel environment handling.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_LOCAL_WEB_PORT = "3000";
const NGROK_API_PORTS = Array.from({ length: 10 }, (_, index) => 4040 + index);
const NGROK_API_FETCH_TIMEOUT_MS = 300;
const NGROK_TERM_TIMEOUT_MS = 1_000;

export function ngrokConfigState() {
  const command = spawnSync("ngrok", ["version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (command.error?.code === "ENOENT") {
    return { available: false, authenticated: false, reason: "missing_binary" };
  }
  if (command.status !== 0) {
    return { available: false, authenticated: false, reason: "version_failed" };
  }

  if (process.env.NGROK_AUTHTOKEN?.trim()) {
    return { available: true, authenticated: true, reason: "env_authtoken" };
  }

  for (const path of ngrokConfigPaths()) {
    if (!existsSync(path)) continue;
    const config = readFileSync(path, "utf8");
    if (/^\s*authtoken:\s*\S+/m.test(config)) {
      return { available: true, authenticated: true, reason: "config_authtoken" };
    }
  }

  return { available: true, authenticated: false, reason: "missing_authtoken" };
}

export function requestedNgrokUrl(args = []) {
  return normalizeUrl(
    valueFor(args, "--url") ??
      process.env.OPENCOMPANY_NGROK_URL ??
      process.env.NGROK_URL ??
      configuredNgrokUrl(),
  );
}

export function startNgrok({ port, url, stdio = ["ignore", "ignore", "pipe"] }) {
  const args = ["http", port];
  if (url) {
    args.push("--url", url);
  }
  if (process.env.NGROK_AUTHTOKEN?.trim()) {
    args.push("--authtoken", process.env.NGROK_AUTHTOKEN.trim());
  }
  return spawn("ngrok", args, { stdio });
}

export async function cleanupOrphanedNgrokProcesses({
  scopePath = defaultNgrokCleanupScope(),
  timeoutMs = NGROK_TERM_TIMEOUT_MS,
} = {}) {
  const processes = listProcesses();
  const cwdByPid = new Map();
  for (const processInfo of processes) {
    if (!isOrphanedNgrok(processInfo)) continue;
    const processCwd = workingDirectoryForPid(processInfo.pid);
    if (processCwd) cwdByPid.set(processInfo.pid, processCwd);
  }

  const stale = selectOrphanedNgrokProcesses(processes, cwdByPid, scopePath);
  for (const processInfo of stale) {
    killPid(processInfo.pid, "SIGTERM");
  }

  const deadline = Date.now() + timeoutMs;
  let remaining = stale.filter((processInfo) => pidIsAlive(processInfo.pid));
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(50);
    remaining = remaining.filter((processInfo) => pidIsAlive(processInfo.pid));
  }

  for (const processInfo of remaining) {
    killPid(processInfo.pid, "SIGKILL");
  }

  return {
    pids: stale.map((processInfo) => processInfo.pid),
    forcedPids: remaining.map((processInfo) => processInfo.pid),
  };
}

export function selectOrphanedNgrokProcesses(processes, cwdByPid, scopePath) {
  const scope = resolve(scopePath);
  return processes.filter((processInfo) => {
    if (!isOrphanedNgrok(processInfo)) return false;
    const processCwd = cwdByPid.get(processInfo.pid);
    return Boolean(processCwd && isPathWithin(processCwd, scope));
  });
}

export async function waitForNgrokUrl(targetPort, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await readNgrokUrl(targetPort);
    if (url) return url;
    await sleep(500);
  }
  return null;
}

export function envForTunnel(
  publicUrl,
  currentEnv = {},
  { localPort = DEFAULT_LOCAL_WEB_PORT } = {},
) {
  const allowedOrigins = appendCsvValue(currentEnv.RUNNER_ALLOWED_ORIGINS, publicUrl);
  return {
    NEXT_PUBLIC_APP_URL: publicUrl,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: localWorkOSRedirectUri(localPort),
    RUNNER_ALLOWED_ORIGINS: allowedOrigins,
  };
}

export function updateLocalEnvForTunnel(
  publicUrl,
  path = ".env.local",
  { localPort = DEFAULT_LOCAL_WEB_PORT } = {},
) {
  if (!existsSync(path)) {
    throw new Error(".env.local is missing. Run `bun run setup` before starting the tunnel.");
  }

  const current = parseEnv(path);
  const values = envForTunnel(publicUrl, current, { localPort });
  writeEnvValues(path, values);

  return values;
}

export function valueFor(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : null;
}

export function localWorkOSRedirectUri(localPort = DEFAULT_LOCAL_WEB_PORT) {
  return `${localWebOrigin(localPort)}/auth/callback`;
}

function ngrokConfigPaths() {
  return [
    join(homedir(), "Library", "Application Support", "ngrok", "ngrok.yml"),
    join(homedir(), ".config", "ngrok", "ngrok.yml"),
  ];
}

function defaultNgrokCleanupScope() {
  const cwd = resolve(process.cwd());
  const conductorWorkspace = process.env.CONDUCTOR_WORKSPACE_PATH?.trim();
  if (!conductorWorkspace) return cwd;

  const workspacePath = resolve(conductorWorkspace);
  return isPathWithin(cwd, workspacePath) ? dirname(workspacePath) : cwd;
}

function listProcesses() {
  const command = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (command.error) throw command.error;
  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || "Unable to inspect local processes.");
  }

  return command.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3].trim(),
    }));
}

function workingDirectoryForPid(pid) {
  const command = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (command.error) throw command.error;
  if (command.status === 1) return null;
  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `Unable to inspect ngrok PID ${pid}.`);
  }

  const pathLine = command.stdout.split("\n").find((line) => line.startsWith("n"));
  return pathLine?.slice(1).trim() || null;
}

function isOrphanedNgrok(processInfo) {
  return processInfo.ppid === 1 && basename(processInfo.command) === "ngrok";
}

function isPathWithin(path, scope) {
  const normalizedPath = resolve(path);
  return normalizedPath === scope || normalizedPath.startsWith(`${scope}${sep}`);
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function configuredNgrokUrl() {
  for (const path of ngrokConfigPaths()) {
    if (!existsSync(path)) continue;
    const config = readFileSync(path, "utf8");
    const match = config.match(/^\s*(?:url|hostname|domain):\s*"?([^"\s]+)"?\s*$/m);
    if (match?.[1]) return match[1];
  }

  return null;
}

function normalizeUrl(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/\/$/, "");
  return `https://${trimmed.replace(/\/$/, "")}`;
}

function localWebOrigin(port) {
  const trimmed = String(port || DEFAULT_LOCAL_WEB_PORT).trim();
  if (/^https?:\/\//.test(trimmed)) return new URL(trimmed).origin;
  if (trimmed.includes(":")) return `http://${trimmed}`.replace(/\/$/, "");
  return `http://localhost:${trimmed}`;
}

async function readNgrokUrl(targetPort) {
  for (const apiPort of NGROK_API_PORTS) {
    const url = await readNgrokUrlFromApiPort(targetPort, apiPort);
    if (url) return url;
  }
  return null;
}

async function readNgrokUrlFromApiPort(targetPort, apiPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`, {
      signal: AbortSignal.timeout(NGROK_API_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const tunnels = Array.isArray(payload.tunnels) ? payload.tunnels : [];
    const matching = tunnels.find((tunnel) => {
      const publicUrl = typeof tunnel.public_url === "string" ? tunnel.public_url : "";
      const addr = typeof tunnel.config?.addr === "string" ? tunnel.config.addr : "";
      return (
        publicUrl.startsWith("https://") &&
        (addr === String(targetPort) || addr.endsWith(`:${targetPort}`))
      );
    });
    return normalizeUrl(matching?.public_url);
  } catch {
    return null;
  }
}

function parseEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function writeEnvValues(path, values) {
  const lines = readFileSync(path, "utf8").split("\n");
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${formatEnvValue(values[match[1]])}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${formatEnvValue(value)}`);
  }

  writeFileSync(
    path,
    `${next.filter((line, index) => line !== "" || index < next.length - 1).join("\n")}\n`,
  );
}

function appendCsvValue(value, nextValue) {
  const values = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.includes(nextValue)) values.push(nextValue);
  return values.join(",");
}

function formatEnvValue(value) {
  if (/^[A-Za-z0-9_./:@,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
