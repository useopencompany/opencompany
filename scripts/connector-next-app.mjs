// Called by: apps/connector package scripts for dev, build, and start.
// Purpose: runs Next.js from the connector app directory with repo-root env loading.

import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = join(repoRoot, "apps", "connector");
const args = argv.slice(2);
const env = { ...process.env };

env.CONNECTOR_WORKOS_REDIRECT_URI ??= "http://localhost:3002/auth/callback";
env.CONNECTOR_APP_URL ??= "http://localhost:3002";

if (args[0] === "dev") {
  env.PORT ??= "3002";
  const hasPortArg = args.includes("-p") || args.includes("--port");
  if (!hasPortArg) {
    args.push("--port", env.PORT);
  }
}

const result = spawnSync("bunx", ["next", ...args], {
  cwd: appRoot,
  env,
  stdio: "inherit",
});

exit(result.status ?? 1);
