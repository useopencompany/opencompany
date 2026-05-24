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

if (!tunnelDisabled) {
  ngrok = await startDefaultTunnel(port);
}

const turboBin = existsSync("node_modules/.bin/turbo") ? "node_modules/.bin/turbo" : "turbo";
const dev = spawn(turboBin, ["dev", ...turboArgs], {
  stdio: "inherit",
  env: { ...process.env, INNGEST_DEV: process.env.INNGEST_DEV ?? "1" },
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
  const config = ngrokConfigState();
  if (!config.available) {
    console.warn("\nngrok is not installed. Install ngrok for integration-ready local dev URLs.\n");
    return null;
  }
  if (!config.authenticated) {
    console.warn(
      "\nngrok is installed but not authenticated. Run `ngrok config add-authtoken <token>` to enable integration-ready local dev URLs.\n",
    );
    return null;
  }

  const url = requestedNgrokUrl(turboArgs);
  const child = startNgrok({ port: targetPort, url });
  child.stderr?.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) console.warn(`[ngrok] ${message}`);
  });

  const publicUrl = await waitForNgrokUrl(targetPort);
  if (!publicUrl) {
    child.kill("SIGTERM");
    console.warn(
      "\nngrok did not expose the local web app in time. Continuing without a tunnel.\n",
    );
    return null;
  }

  try {
    updateLocalEnvForTunnel(publicUrl);
    console.log(`\nngrok tunnel ready: ${publicUrl}`);
    console.log(`GitHub callback URL: ${publicUrl}/api/integrations/github/callback`);
    console.log("Updated .env.local before starting dev.\n");
  } catch (error) {
    child.kill("SIGTERM");
    console.warn(`\nngrok started, but .env.local could not be updated: ${error.message}\n`);
    return null;
  }

  return child;
}
