import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = join(repoRoot, "apps", "web");
const args = argv.slice(2);
const env = { ...process.env };

if (args[0] === "dev") {
  env.INNGEST_DEV = "1";
  env.PORT ??= "3000";
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
