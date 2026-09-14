import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TERM_TIMEOUT_MS = 2_000;

export function normalizePort(port) {
  const normalized = String(port ?? "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid port: ${port}`);
  }

  const value = Number(normalized);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }

  return normalized;
}

export function findPortListeners(port, { runCommand = spawnSync } = {}) {
  const normalized = normalizePort(port);
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  const lsof = runCommand("lsof", [`-tiTCP:${normalized}`, "-sTCP:LISTEN"], options);

  if (lsof.error && lsof.error.code !== "ENOENT") {
    throw lsof.error;
  }
  if (!lsof.error) {
    if (lsof.status && lsof.status !== 1) {
      throw new Error(lsof.stderr.trim() || `lsof failed for port ${normalized}.`);
    }
    return uniquePids(lsof.stdout);
  }

  const ss = runCommand("ss", ["-H", "-ltnp", `sport = :${normalized}`], options);
  if (ss.error) {
    if (ss.error.code === "ENOENT") {
      throw new Error("Port inspection requires either lsof or ss on PATH.");
    }
    throw ss.error;
  }
  if (ss.status) {
    throw new Error(ss.stderr.trim() || `ss failed for port ${normalized}.`);
  }

  const pids = uniqueSsPids(ss.stdout);
  if (ss.stdout.trim() && pids.length === 0) {
    throw new Error(`ss found a listener on port ${normalized} but could not resolve its PID.`);
  }
  return pids;
}

export async function killPortListeners(
  port,
  { signal = "SIGTERM", forceSignal = "SIGKILL", timeoutMs = DEFAULT_TERM_TIMEOUT_MS } = {},
) {
  const normalized = normalizePort(port);
  const pids = findPortListeners(normalized);
  if (pids.length === 0) {
    return { port: normalized, pids: [], forcedPids: [] };
  }

  for (const pid of pids) {
    killPid(pid, signal);
  }

  const released = await waitForPortRelease(normalized, timeoutMs);
  if (released) {
    return { port: normalized, pids, forcedPids: [] };
  }

  const remaining = findPortListeners(normalized);
  for (const pid of remaining) {
    killPid(pid, forceSignal);
  }
  const forceReleased = await waitForPortRelease(normalized, 500);
  if (!forceReleased) {
    throw new Error(
      `Port ${normalized} is still in use by PID ${findPortListeners(normalized).join(", ")}.`,
    );
  }

  return { port: normalized, pids, forcedPids: remaining };
}

async function waitForPortRelease(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (findPortListeners(port).length === 0) {
      return true;
    }
    await delay(50);
  } while (Date.now() < deadline);

  return false;
}

function killPid(pid, signal) {
  try {
    process.kill(Number(pid), signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
}

function uniquePids(stdout) {
  return [
    ...new Set(
      stdout
        .split(/\s+/)
        .map((pid) => pid.trim())
        .filter(Boolean),
    ),
  ];
}

function uniqueSsPids(stdout) {
  return [...new Set([...stdout.matchAll(/\bpid=(\d+)\b/g)].map((match) => match[1]))];
}
