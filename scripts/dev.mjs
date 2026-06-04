// Called by: root `bun run dev` and `bun run dev:stream`.
// Purpose: starts ngrok when available, then runs the local Turbo dev stack.

import "./load-env.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { exit } from "node:process";
import {
  DURABLE_STREAMS_DEV_URL,
  startDurableStreamsDevServer,
} from "./lib/durable-streams-dev.mjs";
import {
  envForTunnel,
  ngrokConfigState,
  requestedNgrokUrl,
  startNgrok,
  valueFor,
  waitForNgrokUrl,
} from "./lib/ngrok-dev.mjs";

const turboArgs = process.argv.slice(2);
const port = valueFor(turboArgs, "--port") ?? process.env.PORT ?? "3000";
const isCI = process.env.CI === "true" || process.env.CI === "1";
const tunnelDisabled = process.env.OPENCOMPANY_NGROK_DISABLED === "1" || isCI;
let ngrok;
let tunnelEnv = {};

if (!tunnelDisabled) {
  ngrok = await startDefaultTunnel(port);
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
    ...durableEnv,
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

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    if (ngrok && !ngrok.killed) ngrok.kill(signal);
    stopDurableStreams();
    if (!dev.killed) dev.kill(signal);
  });
}

dev.on("exit", (code, signal) => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  stopDurableStreams();
  if (shuttingDown) exit(0);
  if (signal) exit(1);
  exit(code ?? 0);
});

dev.on("error", (error) => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  stopDurableStreams();
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

async function startDefaultTunnel(targetPort) {
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
    tunnelEnv = envForTunnel(publicUrl, process.env, { localPort: targetPort });
    console.log(`\nngrok tunnel ready: ${publicUrl}`);
    console.log(`GitHub callback URL: ${publicUrl}/api/integrations/github/callback`);
    console.log(`WorkOS redirect URI: ${tunnelEnv.NEXT_PUBLIC_WORKOS_REDIRECT_URI}`);
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
