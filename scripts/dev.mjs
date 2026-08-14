// Called by: root `bun run dev`, `bun run dev:web`, and `bun run dev:tui`.
// Purpose: starts the web dev proxy, local HTTPS, and ngrok when available, then runs
// the local Turbo dev stack (web app + runner + Stripe listener).

import "./load-env.mjs";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { exit } from "node:process";
import { startWebLocalHttpsProxy, webHttpsDisabled, webHttpsPort } from "./lib/caddy-dev.mjs";
import { ELECTRIC_LOCAL_URL } from "./lib/electric-dev.mjs";
import {
  envForTunnel,
  ngrokConfigState,
  requestedNgrokUrl,
  startNgrok,
  valueFor,
  waitForNgrokUrl,
} from "./lib/ngrok-dev.mjs";
import { findPortListeners } from "./lib/port-kill.mjs";
import { resolveWebDevEnv } from "./lib/web-dev-env.mjs";
import { isolatedWebDevEnvironment, selectWebDevPorts } from "./lib/web-dev-ports.mjs";
import { startWebDevProxy } from "./lib/web-dev-proxy.mjs";

const turboArgs = process.argv.slice(2);
const webDevPorts = selectWebDevPorts({ httpsDisabled: webHttpsDisabled() });
if (webDevPorts?.isolated) {
  console.log(
    `\nConfigured web ports are already in use; using this workspace's isolated ports ` +
      `(${webDevPorts.app}-${webDevPorts.electric}).`,
  );
  Object.assign(
    process.env,
    isolatedWebDevEnvironment(webDevPorts, { httpsDisabled: webHttpsDisabled() }),
  );
}
const defaultPort = process.env.OPENCOMPANY_PORT ?? "3002";
const port = valueFor(turboArgs, "--port") ?? defaultPort;
const isCI = process.env.CI === "true" || process.env.CI === "1";
const tunnelDisabled = process.env.OPENCOMPANY_NGROK_DISABLED === "1" || isCI;
configureDevLogFile(turboArgs);
let ngrok;
let tunnelEnv = {};
let webHttpsEnv = {};
let webDevProxy = null;
let webLocalHttps = null;
let webProxyTarget = null;
let dev = null;
let shuttingDown = false;

process.on("uncaughtExceptionMonitor", (error, origin) => {
  recordSupervisorCrash(error, origin);
});

process.on("exit", () => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  stopWebLocalHttps();
  if (dev?.exitCode === null && !dev.killed) {
    killProcessTree(dev, "SIGTERM");
  }
});

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const childSignal = signal === "SIGHUP" ? "SIGTERM" : signal;
    if (ngrok && !ngrok.killed) ngrok.kill(childSignal);
    stopWebLocalHttps();
    stopWebDevProxy();
    if (dev) {
      stopDevProcess(childSignal);
    } else {
      exit(0);
    }
  });
}

assertWebDevPortsAvailable();
webProxyTarget = await prepareWebProxyTarget(port);
webLocalHttps = await startWebHttps(webProxyTarget.port);

if (!tunnelDisabled) {
  ngrok = await startDefaultTunnel(webProxyTarget.port, {
    appPort: port,
    exposesRunnerCallbacks: webProxyTarget.exposesRunnerCallbacks,
  });
}

const turboBin = existsSync("node_modules/.bin/turbo") ? "node_modules/.bin/turbo" : "turbo";
const devEnvironment = {
  ...process.env,
  ...tunnelEnv,
  ...webHttpsEnv,
  ...resolveWebDevEnv({ port, processEnv: process.env, tunnelEnv, webHttpsEnv }),
  OPENCOMPANY_DEV_APP: "web",
};
if (process.env.OPENCOMPANY_COMMUNITY_MODE === "1") {
  disableElectric(devEnvironment);
} else {
  useLocalElectric(devEnvironment);
}
dev = spawn(turboBin, ["dev", ...turboArgs], {
  stdio: "inherit",
  env: devEnvironment,
});

function useLocalElectric(env) {
  env.ELECTRIC_URL = ELECTRIC_LOCAL_URL;
  // Electric Cloud credentials injected by Infisical identify a hosted source and must never be
  // paired with the branch-local Electric service started by `bun run setup`.
  delete env.ELECTRIC_SOURCE_ID;
  delete env.ELECTRIC_SOURCE_SECRET;
  delete env.ELECTRIC_TOKEN;
}

function disableElectric(env) {
  delete env.ELECTRIC_URL;
  delete env.ELECTRIC_SOURCE_ID;
  delete env.ELECTRIC_SOURCE_SECRET;
  delete env.ELECTRIC_SECRET;
  delete env.ELECTRIC_TOKEN;
}

function stopWebDevProxy() {
  if (webDevProxy) {
    webDevProxy.close().catch(() => {});
    webDevProxy = null;
  }
}

function stopWebLocalHttps() {
  if (webLocalHttps) {
    webLocalHttps.close();
    webLocalHttps = null;
  }
}

function configureDevLogFile(args) {
  if (isCI) return null;
  if (args.some((arg) => arg === "--log-file" || arg.startsWith("--log-file="))) return null;

  const configured = process.env.OPENCOMPANY_DEV_LOG_FILE?.trim();
  if (configured === "0" || configured === "false" || configured === "off") return null;

  const logFile = configured || ".context/logs/dev-turbo.json";
  mkdirSync(".context/logs", { recursive: true });
  args.push(`--log-file=${logFile}`);
  console.log(`\nDev logs: ${logFile}`);
  console.log("Read them with: bun run dev:logs -- --tail 100 --source runner\n");
  return logFile;
}

function recordSupervisorCrash(error, origin) {
  try {
    mkdirSync(".context/logs", { recursive: true });
    const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
    appendFileSync(
      ".context/logs/dev-supervisor.log",
      `[${new Date().toISOString()}] ${origin}\n${details}\n\n`,
      { mode: 0o600 },
    );
  } catch {
    // Preserve Node's original uncaught-exception behavior if diagnostics fail.
  }
}

function stopDevProcess(signal = "SIGTERM") {
  if (!dev) return;
  killProcessTree(dev, signal);
}

function killProcessTree(child, signal = "SIGTERM") {
  if (!child.pid) return;

  for (const pid of descendantPids(child.pid)) {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have already exited while we were walking the tree.
    }
  }

  if (!child.killed) {
    child.kill(signal);
  }
}

function descendantPids(rootPid) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return [];

  const childrenByParent = new Map();
  for (const line of result.stdout.split("\n")) {
    const [pidText, parentPidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const pids = [];
  const visit = (pid) => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      visit(childPid);
      pids.push(childPid);
    }
  };
  visit(rootPid);
  return pids;
}

dev.on("exit", (code, signal) => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  stopWebLocalHttps();
  stopWebDevProxy();
  if (shuttingDown) exit(0);
  if (signal) exit(1);
  exit(code ?? 0);
});

dev.on("error", (error) => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  stopWebLocalHttps();
  stopWebDevProxy();
  console.error(`\nFailed to start turbo dev: ${error.message}\n`);
  exit(1);
});

async function prepareWebProxyTarget(appPort) {
  const runnerPort = localRunnerPort();
  webDevProxy = await startWebDevProxy({ appPort, runnerPort });
  console.log(`\nWeb dev proxy ready: http://127.0.0.1:${webDevProxy.port}`);
  console.log(`  app routes    -> ${webDevProxy.routes.app}`);
  console.log(
    `  runner routes -> ${webDevProxy.routes.runner} (/broker/*, /goat/runtime, /goat/dictation, *.preview.localhost)\n`,
  );
  return { port: webDevProxy.port, exposesRunnerCallbacks: true };
}

function assertWebDevPortsAvailable() {
  if (isCI) return;

  const ports = [
    { label: "web app", port },
    { label: "API", port: localApiPort() },
    { label: "runner", port: localRunnerPort() },
  ];
  if (!webHttpsDisabled()) {
    ports.push({ label: "web HTTPS", port: webHttpsPort() });
  }
  const busy = [];
  for (const { label, port } of dedupePorts(ports)) {
    const pids = findPortListeners(port);
    if (pids.length > 0) busy.push({ label, port, pids });
  }

  if (busy.length === 0) return;

  const details = busy
    .map(({ label, port, pids }) => `  ${label} :${port} (PID ${pids.join(", ")})`)
    .join("\n");
  console.error(
    `\nCannot start web dev because required ports are already in use:\n${details}\n\n` +
      "Another dev stack may be running. Stop it first; dev:web will not terminate " +
      "processes owned by another workspace.\n",
  );
  exit(1);
}

function localApiPort() {
  if (webDevPorts) return webDevPorts.api;
  return "3001";
}

function dedupePorts(ports) {
  const seen = new Set();
  const unique = [];
  for (const entry of ports) {
    const key = String(entry.port);
    if (seen.has(key)) continue;
    unique.push(entry);
    seen.add(key);
  }
  return unique;
}

async function startWebHttps(targetPort) {
  const proxy = await startWebLocalHttpsProxy({ targetPort });
  if (!proxy) return null;

  const webRedirectUri = `${proxy.url}/auth/callback`;
  webHttpsEnv = {
    OPENCOMPANY_NEXT_PUBLIC_APP_URL: proxy.url,
    OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: webRedirectUri,
    NEXT_PUBLIC_APP_URL: proxy.url,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: webRedirectUri,
    WORKOS_REDIRECT_URI: webRedirectUri,
  };

  console.log(`\nWeb local HTTPS ready: ${proxy.url}`);
  console.log(`  Caddy config: ${proxy.configPath}`);
  console.log(`  WorkOS redirect URI: ${webRedirectUri}`);
  console.log("  Open this URL for local web dev so Electric shapes use HTTP/2.\n");
  console.log(
    "  If the browser warns about the certificate, run `caddy trust` while dev is running.\n",
  );
  return proxy;
}

function localRunnerPort() {
  if (webDevPorts) return webDevPorts.runner;

  const configured =
    process.env.RUNNER_INTERNAL_URL?.trim() || process.env.RUNNER_PUBLIC_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.port) return url.port;
      return url.protocol === "https:" ? "443" : "80";
    } catch {
      // Fall through to the local dev default.
    }
  }
  return "3040";
}

async function startDefaultTunnel(
  targetPort,
  { appPort = targetPort, exposesRunnerCallbacks = false } = {},
) {
  const url = requestedNgrokUrl(turboArgs);
  const required = Boolean(url) || process.env.OPENCOMPANY_NGROK_REQUIRED === "1";
  const config = ngrokConfigState();
  if (!config.available) {
    const message =
      "\nngrok is not installed. Install ngrok for integration-ready local dev URLs.\n";
    if (required) {
      console.error(message);
      exit(1);
    }
    console.warn(message);
    return null;
  }
  if (!config.authenticated) {
    const message =
      "\nngrok authentication could not be verified from local env/config. Attempting to start ngrok anyway.\n";
    console.warn(message);
  }

  const child = startNgrok({ port: targetPort, url });
  ngrok = child;
  child.on("error", (error) => {
    console.error(`\nFailed to start ngrok: ${error.message}\n`);
    exit(1);
  });
  child.stderr?.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) console.warn(`[ngrok] ${message}`);
  });

  const publicUrl = await waitForNgrokUrl(targetPort);
  if (!publicUrl) {
    child.kill("SIGTERM");
    const message = "\nngrok did not expose the local web app in time.\n";
    if (required) {
      console.error(message);
      exit(1);
    }
    console.warn(`${message}Continuing without a tunnel.\n`);
    return null;
  }

  try {
    tunnelEnv = envForTunnel(publicUrl, process.env, { localPort: appPort });
    if (exposesRunnerCallbacks) {
      tunnelEnv = {
        ...tunnelEnv,
        OPENCOMPANY_NEXT_PUBLIC_APP_URL: publicUrl,
        NEXT_PUBLIC_APP_URL: publicUrl,
      };
    }
    console.log(`\nngrok tunnel ready: ${publicUrl}`);
    if (exposesRunnerCallbacks) {
      console.log(`Web public URL: ${publicUrl}`);
      console.log(`Web GitHub callback URL: ${publicUrl}/api/integrations/github/callback`);
    } else {
      console.log(`GitHub callback URL: ${publicUrl}/api/integrations/github/callback`);
      console.log(`WorkOS redirect URI: ${tunnelEnv.NEXT_PUBLIC_WORKOS_REDIRECT_URI}`);
    }
    if (exposesRunnerCallbacks) {
      console.log(`Runner sandbox callback URL: ${publicUrl}`);
    }
    console.log("Injected tunnel env into the dev process without changing .env.local.\n");
  } catch (error) {
    child.kill("SIGTERM");
    const message = `\nngrok started, but tunnel env could not be prepared: ${error.message}\n`;
    if (required) {
      console.error(message);
      exit(1);
    }
    console.warn(message);
    return null;
  }

  return child;
}
