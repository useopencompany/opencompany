// Called by: scripts/dev.mjs and scripts/setup.mjs.
// Purpose: local HTTPS/HTTP2 proxy for Goat dev so Electric long-poll shapes
// do not consume the browser's small HTTP/1.1 connection pool.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_GOAT_HTTPS_PORT = "3443";
export const GOAT_HTTPS_DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function goatHttpsDisabled(env = process.env) {
  return GOAT_HTTPS_DISABLED_VALUES.has(
    String(env.OPENCOMPANY_GOAT_HTTPS_DISABLED ?? "")
      .trim()
      .toLowerCase(),
  );
}

export function goatHttpsPort(env = process.env) {
  return String(env.GOAT_HTTPS_PORT?.trim() || DEFAULT_GOAT_HTTPS_PORT);
}

export function goatHttpsOrigin(env = process.env) {
  const configured = env.GOAT_NEXT_PUBLIC_APP_URL?.trim();
  if (configured?.startsWith("https://localhost")) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the default port.
    }
  }
  return `https://localhost:${goatHttpsPort(env)}`;
}

export function caddyState() {
  const result = spawnSync("caddy", ["version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ENOENT") {
    return { available: false, reason: "missing_binary" };
  }
  if (result.status !== 0) {
    return {
      available: false,
      reason: "version_failed",
      message: result.stderr.trim() || result.stdout.trim(),
    };
  }
  return { available: true, version: result.stdout.trim() || result.stderr.trim() };
}

export function homebrewAvailable() {
  const result = spawnSync("brew", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

export function installCaddyWithHomebrew({ stdio = "inherit" } = {}) {
  return spawnSync("brew", ["install", "caddy"], {
    stdio,
    timeout: 300_000,
  });
}

export function trustCaddyLocalCA({ stdio = "inherit" } = {}) {
  return spawnSync("caddy", ["trust"], {
    stdio,
    timeout: 120_000,
  });
}

export async function startGoatLocalHttpsProxy({
  targetPort,
  env = process.env,
  onWarning = console.warn,
} = {}) {
  if (goatHttpsDisabled(env)) {
    onWarning("\nGoat local HTTPS is disabled by OPENCOMPANY_GOAT_HTTPS_DISABLED=1.\n");
    return null;
  }
  if (!targetPort) {
    throw new Error("startGoatLocalHttpsProxy requires targetPort.");
  }

  const state = caddyState();
  if (!state.available) {
    onWarning(
      "\nCaddy is not installed, so Goat local dev will use HTTP/1.1. " +
        "Run `bun run setup` or `brew install caddy` to enable local HTTPS/HTTP2.\n",
    );
    return null;
  }

  const origin = goatHttpsOrigin(env);
  const url = new URL(origin);
  const host = url.hostname || "localhost";
  const port = url.port || "443";
  const configDir = join(".context", "caddy");
  const configPath = join(configDir, "goat.Caddyfile");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, goatCaddyfile({ host, port, targetPort }));

  const child = spawn("caddy", ["run", "--config", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const earlyExit = await waitForEarlyExit(child, 900);
  if (earlyExit) {
    const details = stderr.trim() ? `\n${indent(stderr.trim())}` : "";
    onWarning(`\nCaddy could not start Goat local HTTPS; falling back to HTTP.${details}\n`);
    return null;
  }

  return {
    url: origin,
    configPath,
    child,
    close(signal = "SIGTERM") {
      if (!child.killed) child.kill(signal);
    },
  };
}

function goatCaddyfile({ host, port, targetPort }) {
  return `{
\tskip_install_trust
}

${host}:${port}, *.preview.localhost:${port} {
\treverse_proxy 127.0.0.1:${targetPort}
\tencode zstd gzip
}
`;
}

function waitForEarlyExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      resolve(null);
    }, timeoutMs);
    function onExit(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
