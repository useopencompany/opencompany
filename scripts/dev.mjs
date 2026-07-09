// Called by: root `bun run dev` and `bun run dev:stream`.
// Purpose: starts ngrok when available, then runs the local Turbo dev stack.

import "./load-env.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { exit } from "node:process";
import { startGoatLocalHttpsProxy } from "./lib/caddy-dev.mjs";
import {
  DURABLE_STREAMS_DEV_URL,
  startDurableStreamsDevServer,
} from "./lib/durable-streams-dev.mjs";
import { startGoatDevProxy } from "./lib/goat-dev-proxy.mjs";
import {
  envForTunnel,
  ngrokConfigState,
  requestedNgrokUrl,
  startNgrok,
  valueFor,
  waitForNgrokUrl,
} from "./lib/ngrok-dev.mjs";

const { appMode, turboArgs } = parseArgs(process.argv.slice(2));
const defaultPort = appMode === "goat" ? (process.env.GOAT_PORT ?? "3002") : "3000";
const port =
  valueFor(turboArgs, "--port") ??
  (appMode === "goat" ? defaultPort : (process.env.PORT ?? defaultPort));
const isCI = process.env.CI === "true" || process.env.CI === "1";
const tunnelDisabled = process.env.OPENCOMPANY_NGROK_DISABLED === "1" || isCI;
configureDevLogFile(turboArgs);
let ngrok;
let tunnelEnv = {};
let goatHttpsEnv = {};
let goatDevProxy = null;
let goatLocalHttps = null;
let goatProxyTarget = null;

if (appMode === "goat") {
  goatProxyTarget = await prepareGoatProxyTarget(port);
  goatLocalHttps = await startGoatHttps(goatProxyTarget.port);
}

if (!tunnelDisabled) {
  const tunnelTarget = goatProxyTarget ?? { port, exposesRunnerCallbacks: false };
  ngrok = await startDefaultTunnel(tunnelTarget.port, {
    appPort: port,
    exposesRunnerCallbacks: tunnelTarget.exposesRunnerCallbacks,
  });
}

// Local session-transcript streaming. The web proxy and runner read
// DURABLE_STREAMS_URL; without it they 503 / no-op. Start the in-memory
// reference server and inject the URL so transcripts stream with no extra setup.
let durableStreams = null;
let durableEnv = {};
if (!isCI) {
  durableStreams = await startDurableStreams();
}

const turboBin = existsSync("node_modules/.bin/turbo") ? "node_modules/.bin/turbo" : "turbo";
const dev = spawn(turboBin, ["dev", ...turboArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...tunnelEnv,
    ...goatHttpsEnv,
    ...durableEnv,
    ...envForAppMode(),
    INNGEST_DEV: process.env.INNGEST_DEV ?? "1",
  },
});

let shuttingDown = false;

function stopDurableStreams() {
  if (durableStreams) {
    durableStreams.stop().catch(() => {});
    durableStreams = null;
  }
}

function stopGoatDevProxy() {
  if (goatDevProxy) {
    goatDevProxy.close().catch(() => {});
    goatDevProxy = null;
  }
}

function stopGoatLocalHttps() {
  if (goatLocalHttps) {
    goatLocalHttps.close();
    goatLocalHttps = null;
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

function parseArgs(args) {
  let appMode = "web";
  const turboArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--app") {
      appMode = args[index + 1] === "goat" ? "goat" : "web";
      index += 1;
      continue;
    }
    if (arg.startsWith("--app=")) {
      appMode = arg.slice("--app=".length) === "goat" ? "goat" : "web";
      continue;
    }
    turboArgs.push(arg);
  }
  return { appMode, turboArgs };
}

function envForAppMode() {
  if (appMode !== "goat") return {};

  const goatAppUrl =
    goatHttpsEnv.GOAT_NEXT_PUBLIC_APP_URL?.trim() ||
    tunnelEnv.GOAT_NEXT_PUBLIC_APP_URL?.trim() ||
    tunnelEnv.NEXT_PUBLIC_APP_URL?.trim() ||
    configuredGoatAppUrl() ||
    `http://localhost:${port}`;
  const goatRedirectUri =
    tunnelEnv.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim() ||
    process.env.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim() ||
    `${goatAppUrl}/auth/callback`;

  return {
    GOAT_NEXT_PUBLIC_APP_URL: goatAppUrl,
    GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
    GOAT_LOCAL_BRIDGE_BASE_URL:
      process.env.GOAT_LOCAL_BRIDGE_BASE_URL?.trim() || `http://127.0.0.1:${port}`,
    NEXT_PUBLIC_APP_URL: goatAppUrl,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
    WORKOS_REDIRECT_URI: goatRedirectUri,
    RUNNER_GOAT_TASK_WORKER_ENABLED: "true",
    RUNNER_ALLOWED_ORIGINS: appendCsvValues(
      process.env.RUNNER_ALLOWED_ORIGINS,
      [goatAppUrl, tunnelEnv.NEXT_PUBLIC_APP_URL, tunnelEnv.GOAT_NEXT_PUBLIC_APP_URL].filter(
        Boolean,
      ),
    ),
  };
}

function configuredGoatAppUrl() {
  const configured = process.env.GOAT_NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return null;
  if (configured.startsWith("https://localhost") && !goatHttpsEnv.GOAT_NEXT_PUBLIC_APP_URL) {
    return null;
  }
  return configured;
}

function appendCsvValues(raw, values) {
  const existing = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set(existing);
  for (const value of values) {
    if (seen.has(value)) continue;
    existing.push(value);
    seen.add(value);
  }
  return existing.join(",");
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    const childSignal = signal === "SIGHUP" ? "SIGTERM" : signal;
    if (ngrok && !ngrok.killed) ngrok.kill(childSignal);
    stopDurableStreams();
    stopGoatLocalHttps();
    stopGoatDevProxy();
    stopDevProcess(childSignal);
  });
}

function stopDevProcess(signal = "SIGTERM") {
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
  stopDurableStreams();
  stopGoatLocalHttps();
  stopGoatDevProxy();
  if (shuttingDown) exit(0);
  if (signal) exit(1);
  exit(code ?? 0);
});

dev.on("error", (error) => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  stopDurableStreams();
  stopGoatLocalHttps();
  stopGoatDevProxy();
  console.error(`\nFailed to start turbo dev: ${error.message}\n`);
  exit(1);
});

// Start the local Durable Streams server and set `durableEnv` so the URL reaches
// the web + runner dev processes. Respects an explicitly configured
// DURABLE_STREAMS_URL (e.g. Electric Cloud), reuses an already-running local
// server, and degrades to a warning (transcripts just won't stream) on failure.
async function startDurableStreams() {
  const configured = process.env.DURABLE_STREAMS_URL?.trim();
  if (configured && !configured.includes("...")) {
    console.log(`\nUsing configured Durable Streams: ${configured}\n`);
    return null;
  }

  try {
    const { url, server } = await startDurableStreamsDevServer();
    durableEnv = { DURABLE_STREAMS_URL: url };
    console.log(`\nDurable Streams (local) ready: ${url}`);
    console.log(
      "Injected DURABLE_STREAMS_URL into the dev process — session transcripts stream.\n",
    );
    return server;
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      durableEnv = { DURABLE_STREAMS_URL: DURABLE_STREAMS_DEV_URL };
      console.log(`\nDurable Streams already running at ${DURABLE_STREAMS_DEV_URL}; reusing it.\n`);
      return null;
    }
    console.warn(
      `\nCould not start local Durable Streams: ${error.message}\n` +
        "  Session transcripts won't live-stream (the proxy returns 503). Continuing.\n",
    );
    return null;
  }
}

async function prepareGoatProxyTarget(appPort) {
  const runnerPort = localRunnerPort();
  goatDevProxy = await startGoatDevProxy({ appPort, runnerPort });
  console.log(`\nGoat dev proxy ready: http://127.0.0.1:${goatDevProxy.port}`);
  console.log(`  app routes    -> ${goatDevProxy.routes.app}`);
  console.log(`  runner routes -> ${goatDevProxy.routes.runner} (/broker/*, /goat/tools/*)\n`);
  return { port: goatDevProxy.port, exposesRunnerCallbacks: true };
}

async function startGoatHttps(targetPort) {
  const proxy = await startGoatLocalHttpsProxy({ targetPort });
  if (!proxy) return null;

  const goatRedirectUri = `${proxy.url}/auth/callback`;
  goatHttpsEnv = {
    GOAT_NEXT_PUBLIC_APP_URL: proxy.url,
    GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
    NEXT_PUBLIC_APP_URL: proxy.url,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
    WORKOS_REDIRECT_URI: goatRedirectUri,
  };

  console.log(`\nGoat local HTTPS ready: ${proxy.url}`);
  console.log(`  Caddy config: ${proxy.configPath}`);
  console.log(`  WorkOS redirect URI: ${goatRedirectUri}`);
  console.log("  Open this URL for local Goat dev so Electric shapes use HTTP/2.\n");
  console.log(
    "  If the browser warns about the certificate, run `caddy trust` while dev is running.\n",
  );
  return proxy;
}

function localRunnerPort() {
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
      const goatRedirectUri = `${publicUrl}/auth/callback`;
      tunnelEnv = {
        ...tunnelEnv,
        GOAT_NEXT_PUBLIC_APP_URL: publicUrl,
        GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
        NEXT_PUBLIC_APP_URL: publicUrl,
        NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
        WORKOS_REDIRECT_URI: goatRedirectUri,
        RUNNER_LLM_BROKER_PUBLIC_URL: publicUrl,
      };
    }
    console.log(`\nngrok tunnel ready: ${publicUrl}`);
    if (exposesRunnerCallbacks) {
      console.log(`Goat public URL: ${publicUrl}`);
      console.log(`Goat GitHub callback URL: ${publicUrl}/api/integrations/github/callback`);
      console.log(`Goat WorkOS redirect URI: ${tunnelEnv.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI}`);
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
