import "./load-env.mjs";
import { existsSync } from "node:fs";
import { exit } from "node:process";
import {
  requestedNgrokUrl,
  startNgrok,
  updateLocalEnvForTunnel,
  valueFor,
  waitForNgrokUrl,
} from "./lib/ngrok-dev.mjs";

const args = process.argv.slice(2);
const HELP = args.includes("--help") || args.includes("-h");
const NO_ENV = args.includes("--no-env");

if (HELP) {
  console.log(`Usage: bun run github:tunnel [-- --url https://name.ngrok.app] [-- --port 3000] [-- --no-env]

Starts an ngrok tunnel to the local web app and writes the public origin to .env.local:
  NEXT_PUBLIC_APP_URL
  NEXT_PUBLIC_WORKOS_REDIRECT_URI
  RUNNER_ALLOWED_ORIGINS

Set OPENCOMPANY_NGROK_URL or NGROK_URL to avoid passing --url each time.
`);
  exit(0);
}

const port = valueFor(args, "--port") ?? process.env.PORT ?? "3000";
const requestedUrl = requestedNgrokUrl(args);
if (!NO_ENV && !existsSync(".env.local")) {
  console.error("\n.env.local is missing. Run `bun run setup` before starting the tunnel.\n");
  exit(1);
}

const child = startNgrok({ port, url: requestedUrl, stdio: ["ignore", "inherit", "inherit"] });
let shuttingDown = false;

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error(
      "\nngrok is not installed or is not on PATH. Install it, run `ngrok config add-authtoken ...`, then retry.\n",
    );
    exit(1);
  }
  console.error(`\nFailed to start ngrok: ${error.message}\n`);
  exit(1);
});

child.on("exit", (code, signal) => {
  if (shuttingDown) exit(0);
  if (signal) {
    console.error(`\nngrok stopped from ${signal}.\n`);
    exit(1);
  }
  exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    child.kill(signal);
  });
}

const publicUrl = await waitForNgrokUrl(port);
if (!publicUrl) {
  child.kill("SIGTERM");
  console.error("\nTimed out waiting for ngrok to expose the local web app.\n");
  exit(1);
}

if (!NO_ENV) {
  updateLocalEnvForTunnel(publicUrl);
}

console.log(`\nGitHub local tunnel is ready: ${publicUrl}`);
console.log(`GitHub callback URL: ${publicUrl}/api/integrations/github/callback`);
console.log(`WorkOS redirect URI: ${publicUrl}/auth/callback`);
if (!NO_ENV) {
  console.log(
    "Updated .env.local. Restart `bun run dev` so Next.js and the runner reload env vars.",
  );
}
console.log("Keep this process running while testing the GitHub integration flow.\n");

await new Promise((resolve) => child.on("close", resolve));
