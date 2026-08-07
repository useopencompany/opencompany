// Called by: root `bun run dev`, `bun run dev:goat`, and `bun run dev:tui`.
// Purpose: starts the opencompany dev proxy, local HTTPS, and ngrok when available, then runs
// the local Turbo dev stack (app + runner).

import "./load-env.mjs";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { exit } from "node:process";
import { resolveDevEnv } from "./lib/app-dev-env.mjs";
import { isolatedDevEnvironment, selectDevPorts } from "./lib/app-dev-ports.mjs";
import { startDevProxy } from "./lib/app-dev-proxy.mjs";
import { httpsDisabled, httpsPort, startLocalHttpsProxy } from "./lib/caddy-dev.mjs";
import {
  envForTunnel,
  ngrokConfigState,
  requestedNgrokUrl,
  startNgrok,
  valueFor,
  waitForNgrokUrl,
} from "./lib/ngrok-dev.mjs";
import { findPortListeners } from "./lib/port-kill.mjs";

const { turboArgs } = parseArgs(process.argv.slice(2));
const devPorts = selectDevPorts({ httpsDisabled: httpsDisabled() });
if (devPorts?.isolated) {
  console.log(
    `\nConfigured opencompany ports are already in use; using this workspace's isolated ports ` +
      `(${devPorts.app}-${devPorts.electric}).`,
  );
  Object.assign(process.env, isolatedDevEnvironment(devPorts, { httpsDisabled: httpsDisabled() }));
}
const defaultPort = process.env.APP_PORT ?? "3002";
const port = valueFor(turboArgs, "--port") ?? defaultPort;
const isCI = process.env.CI === "true" || process.env.CI === "1";
const tunnelDisabled = process.env.OPENCOMPANY_NGROK_DISABLED === "1" || isCI;
configureDevLogFile(turboArgs);
let ngrok;
let tunnelEnv = {};
let httpsEnv = {};
let devProxy = null;
let localHttps = null;
let proxyTarget = null;
let dev = null;
let shuttingDown = false;

process.on("uncaughtExceptionMonitor", (error, origin) => {
  recordSupervisorCrash(error, origin);
});

process.on("exit", () => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  stopLocalHttps();
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
    stopLocalHttps();
    stopDevProxy();
    if (dev) {
      stopDevProcess(childSignal);
    } else {
      exit(0);
    }
  });
}

assertDevPortsAvailable();
proxyTarget = await prepareProxyTarget(port);
localHttps = await startHttps(proxyTarget.port);

if (!tunnelDisabled) {
  ngrok = await startDefaultTunnel(proxyTarget.port, {
    appPort: port,
    exposesRunnerCallbacks: proxyTarget.exposesRunnerCallbacks,
  });
}

const turboBin = existsSync("node_modules/.bin/turbo") ? "node_modules/.bin/turbo" : "turbo";
dev = spawn(turboBin, ["dev", ...turboArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...tunnelEnv,
    ...httpsEnv,
    ...resolveDevEnv({ port, processEnv: process.env, tunnelEnv, httpsEnv }),
  },
});

function stopDevProxy() {
  if (devProxy) {
    devProxy.close().catch(() => {});
    devProxy = null;
  }
}

function stopLocalHttps() {
  if (localHttps) {
    localHttps.close();
    localHttps = null;
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

function parseArgs(args) {
  const turboArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    // Historical flag from the two-app era; the opencompany stack is the only mode now.
    if (arg === "--app") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--app=")) {
      continue;
    }
    turboArgs.push(arg);
  }
  return { turboArgs };
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
  stopLocalHttps();
  stopDevProxy();
  if (shuttingDown) exit(0);
  if (signal) exit(1);
  exit(code ?? 0);
});

dev.on("error", (error) => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  stopLocalHttps();
  stopDevProxy();
  console.error(`\nFailed to start turbo dev: ${error.message}\n`);
  exit(1);
});

async function prepareProxyTarget(appPort) {
  const runnerPort = localRunnerPort();
  devProxy = await startDevProxy({ appPort, runnerPort });
  console.log(`\nopencompany dev proxy ready: http://127.0.0.1:${devProxy.port}`);
  console.log(`  app routes    -> ${devProxy.routes.app}`);
  console.log(
    `  runner routes -> ${devProxy.routes.runner} (/broker/*, /goat/runtime, /goat/dictation, *.preview.localhost)\n`,
  );
  return { port: devProxy.port, exposesRunnerCallbacks: true };
}

function assertDevPortsAvailable() {
  if (isCI) return;

  const ports = [
    { label: "app", port },
    { label: "runner", port: localRunnerPort() },
  ];
  if (!httpsDisabled()) {
    ports.push({ label: "opencompany HTTPS", port: httpsPort() });
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
    `\nCannot start opencompany dev because required ports are already in use:\n${details}\n\n` +
      "Another dev stack may be running. Stop it first; dev:goat will not terminate " +
      "processes owned by another workspace.\n",
  );
  exit(1);
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

async function startHttps(targetPort) {
  const proxy = await startLocalHttpsProxy({ targetPort });
  if (!proxy) return null;

  const redirectUri = `${proxy.url}/auth/callback`;
  httpsEnv = {
    NEXT_PUBLIC_APP_URL: proxy.url,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: redirectUri,
    NEXT_PUBLIC_APP_URL: proxy.url,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: redirectUri,
    WORKOS_REDIRECT_URI: redirectUri,
  };

  console.log(`\nopencompany local HTTPS ready: ${proxy.url}`);
  console.log(`  Caddy config: ${proxy.configPath}`);
  console.log(`  WorkOS redirect URI: ${redirectUri}`);
  console.log("  Open this URL for local opencompany dev so Electric shapes use HTTP/2.\n");
  console.log(
    "  If the browser warns about the certificate, run `caddy trust` while dev is running.\n",
  );
  return proxy;
}

function localRunnerPort() {
  if (devPorts) return devPorts.runner;

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
    const message = "\nngrok did not expose the local app in time.\n";
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
        NEXT_PUBLIC_APP_URL: publicUrl,
        NEXT_PUBLIC_APP_URL: publicUrl,
        RUNNER_LLM_BROKER_PUBLIC_URL: publicUrl,
      };
    }
    console.log(`\nngrok tunnel ready: ${publicUrl}`);
    if (exposesRunnerCallbacks) {
      console.log(`opencompany public URL: ${publicUrl}`);
      console.log(`opencompany GitHub callback URL: ${publicUrl}/api/integrations/github/callback`);
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
