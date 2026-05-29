// Called by: root `bun run dev` and `bun run dev:stream`.
// Purpose: starts ngrok when available, then runs the local Turbo dev stack.

import "./load-env.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { exit } from "node:process";
import {
  ngrokConfigState,
  requestedNgrokUrl,
  startNgrok,
  updateLocalEnvForTunnel,
  valueFor,
  waitForNgrokUrl,
} from "./lib/ngrok-dev.mjs";

const turboArgs = process.argv.slice(2);
const port = valueFor(turboArgs, "--port") ?? process.env.PORT ?? "3000";
const tunnelDisabled =
  process.env.OPENCOMPANY_NGROK_DISABLED === "1" ||
  process.env.CI === "true" ||
  process.env.CI === "1";
let ngrok;
let tunnelEnv = {};

if (!tunnelDisabled) {
  ngrok = await startDefaultTunnel(port);
}

const turboBin = existsSync("node_modules/.bin/turbo") ? "node_modules/.bin/turbo" : "turbo";
const dev = spawn(turboBin, ["dev", ...turboArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...tunnelEnv,
    INNGEST_DEV: process.env.INNGEST_DEV ?? "1",
  },
});

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    if (ngrok && !ngrok.killed) ngrok.kill(signal);
    if (!dev.killed) dev.kill(signal);
  });
}

dev.on("exit", (code, signal) => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  if (shuttingDown) exit(0);
  if (signal) exit(1);
  exit(code ?? 0);
});

dev.on("error", (error) => {
  if (ngrok && !ngrok.killed) ngrok.kill("SIGTERM");
  console.error(`\nFailed to start turbo dev: ${error.message}\n`);
  exit(1);
});

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
    tunnelEnv = updateLocalEnvForTunnel(publicUrl, ".env.local", { localPort: targetPort });
    console.log(`\nngrok tunnel ready: ${publicUrl}`);
    console.log(`GitHub callback URL: ${publicUrl}/api/integrations/github/callback`);
    console.log(`WorkOS redirect URI: ${tunnelEnv.NEXT_PUBLIC_WORKOS_REDIRECT_URI}`);
    console.log("Updated .env.local before starting dev.\n");
  } catch (error) {
    child.kill("SIGTERM");
    const message = `\nngrok started, but .env.local could not be updated: ${error.message}\n`;
    if (required) {
      console.error(message);
      exit(1);
    }
    console.warn(message);
    return null;
  }

  return child;
}
