// Called by: apps/app package scripts for dev, build, and start.
// Purpose: runs Next.js from the app directory with repo-root env loading and
// local opencompany-specific WorkOS defaults.

import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = join(repoRoot, "apps", "app");
const args = argv.slice(2);
const env = { ...process.env };

if (args[0] === "dev") {
  env.PORT = env.APP_PORT?.trim() || "3002";
  const hasPortArg = args.includes("-p") || args.includes("--port");
  if (!hasPortArg) {
    args.push("--port", env.PORT);
  }

  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim() || `http://localhost:${env.PORT}`;
  env.NEXT_PUBLIC_APP_URL = appUrl;
  env.NEXT_PUBLIC_WORKOS_REDIRECT_URI =
    env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim() || `${appUrl}/auth/callback`;
  env.WORKOS_REDIRECT_URI ||= env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
} else {
  if (env.NEXT_PUBLIC_APP_URL?.trim()) {
    env.NEXT_PUBLIC_APP_URL = env.NEXT_PUBLIC_APP_URL.trim();
  }
  if (env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim()) {
    env.NEXT_PUBLIC_WORKOS_REDIRECT_URI = env.NEXT_PUBLIC_WORKOS_REDIRECT_URI.trim();
    env.WORKOS_REDIRECT_URI ||= env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
  }
}

const result = spawnSync("bunx", ["next", ...args], {
  cwd: appRoot,
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Could not run next from ${appRoot}:`, result.error.message);
}
exit(result.status ?? 1);
