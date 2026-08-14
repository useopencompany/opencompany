// Local Electric sync service for dev (no Electric Cloud needed). Runs the
// electricsql/electric Docker image in the FOREGROUND, pointed at your Neon
// DIRECT (non-pooled) connection, so the web app's TanStack DB collections sync
// out of Postgres. Use this when you want to watch Electric's logs.
//
// `bun run setup` already starts Electric detached when a container runtime is
// present, so most of the time you don't need this — reach for it to tail logs
// or restart against a freshly rebranched database.
//
// Prereqs (one-time):
//   1. A container runtime with `docker` on PATH — OrbStack (https://orbstack.dev,
//      lightweight on macOS) or Docker Desktop.
//   2. Logical replication enabled on the Neon project (Neon console → project
//      Settings → enable logical replication). Project-level, so it applies to
//      every branch. Electric creates its own publication + slot.
//
// Usage:
//   bun run electric:dev
// Then point the web env at it (setup does this for you):
//   ELECTRIC_URL="http://localhost:3010"

import "./load-env.mjs";
import { spawn, spawnSync } from "node:child_process";
import {
  directDatabaseUrl,
  dockerRunArgs,
  ELECTRIC_CONTAINER,
  ELECTRIC_PORT,
} from "./lib/electric-dev.mjs";

const databaseUrl = directDatabaseUrl();
if (!databaseUrl) {
  console.error(
    "\n  No database URL found. Set DATABASE_URL (pull env first) or ELECTRIC_DATABASE_URL.\n",
  );
  process.exit(1);
}

// Take over from any container `bun run setup` started detached (same name),
// so foreground logs reflect the current database. Ignore "no such container".
spawnSync("docker", ["rm", "-f", ELECTRIC_CONTAINER], { stdio: "ignore" });

console.log(`\n  Starting Electric at http://localhost:${ELECTRIC_PORT} (insecure dev mode)`);
console.log(`  → set ELECTRIC_URL="http://localhost:${ELECTRIC_PORT}" in your local API env\n`);

const child = spawn("docker", dockerRunArgs(databaseUrl), { stdio: "inherit" });

child.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error(
      "\n  `docker` not found. Install OrbStack (https://orbstack.dev) or Docker Desktop, then retry.\n",
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

const shutdown = () => child.kill("SIGINT");
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => process.exit(code ?? 0));
