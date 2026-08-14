// Credential-free community development entry point. It owns the embedded Postgres lifecycle,
// applies the checked-in migrations, and then starts only the web/API/runner product runtimes.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const databasePort = communityDatabasePort(process.env);
const databaseDirectory = join(repositoryRoot, ".opencompany", "community-db");
const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${databasePort}/postgres?sslmode=disable`;
const communityEnv = createCommunityEnv(process.env, databaseUrl);

mkdirSync(dirname(databaseDirectory), { recursive: true });

console.log("\nStarting opencompany in community development mode.");
console.log(`  database  PGlite at 127.0.0.1:${databasePort}`);
console.log("  web       http://localhost:3002 (or the isolated port printed below)");
console.log("  API       http://localhost:3001");
console.log("  runner    http://localhost:3040");
console.log("\nProvider status:");
console.log("  - WorkOS sign-in is disabled until you supply your own WorkOS project.");
console.log(
  "  - Model execution and background workers are disabled without provider credentials.",
);
console.log(
  "  - Electric live reads, billing, integrations, tunnels, and hosted telemetry are disabled.",
);
console.log("  - Web, API, runner, Postgres, OpenAPI, and health endpoints remain available.\n");

const database = await PGlite.create(databaseDirectory, {
  extensions: { pg_trgm, vector },
});
const socketServer = new PGLiteSocketServer({
  db: database,
  host: "127.0.0.1",
  port: databasePort,
});

let activeChild = null;
let stopping = false;

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    if (activeChild && activeChild.exitCode === null && !activeChild.killed) {
      activeChild.kill(signal === "SIGHUP" ? "SIGTERM" : signal);
    }
  });
}

try {
  await socketServer.start();
  console.log("Applying checked-in migrations to the community database...\n");
  await run("bun", ["--filter", "@opencompany/db", "db:migrate"], communityEnv);
  if (stopping) process.exitCode = 130;
  else {
    console.log("\nMigrations are current. Starting the three product runtimes...\n");
    process.exitCode = await run(
      process.execPath,
      [
        "scripts/dev.mjs",
        "--ui=stream",
        "--env-mode=loose",
        "--filter=@opencompany/web",
        "--filter=@opencompany/api",
        "--filter=@opencompany/runner",
      ],
      communityEnv,
    );
  }
} finally {
  await socketServer.stop().catch(() => undefined);
  await database.close().catch(() => undefined);
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (signal && !stopping) {
        reject(new Error(`${command} exited after ${signal}.`));
        return;
      }
      resolve(code ?? (stopping ? 130 : 1));
    });
  });
}

function createCommunityEnv(source, url) {
  const env = {
    ...source,
    OPENCOMPANY_COMMUNITY_MODE: "1",
    OPENCOMPANY_HTTPS_DISABLED: "1",
    OPENCOMPANY_NGROK_DISABLED: "1",
    OPENCOMPANY_DEV_LOG_FILE: "0",
    DATABASE_URL: url,
    API_DATABASE_URL: url,
    API_DB_POOL_MAX: "1",
    RUNNER_DATABASE_URL: url,
    RUNNER_DB_POOL_MAX: "1",
    OPENCOMPANY_PORT: source.OPENCOMPANY_PORT?.trim() || "3002",
    OPENCOMPANY_NEXT_PUBLIC_APP_URL: "http://localhost:3002",
    OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://localhost:3002/auth/callback",
    OPENCOMPANY_API_ORIGIN: "http://127.0.0.1:3001",
    NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN: "",
    RUNNER_PUBLIC_URL: "http://127.0.0.1:3040",
    RUNNER_INTERNAL_URL: "http://127.0.0.1:3040",
    RUNNER_INTERNAL_TOKEN: "community-runner-internal-token",
    RUNNER_STREAM_TOKEN_SECRET: "community-runner-stream-token-secret",
    RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED: "false",
    RUNNER_OPENCOMPANY_BROWSER_ENABLED: "false",
    RUNNER_ALLOWED_ORIGINS: "http://localhost:3002",
    WORKOS_CLIENT_ID: "client_community_not_configured",
    WORKOS_API_KEY: "sk_test_community_not_configured",
    WORKOS_COOKIE_PASSWORD: "community-cookie-password-not-for-production",
    OPENCOMPANY_AUTHKIT_DOMAIN: "",
    OPENCOMPANY_API_OAUTH_AUDIENCE: "",
    OPENCOMPANY_STRIPE_API_KEY: "sk_test_community_not_configured",
    OPENCOMPANY_STRIPE_WEBHOOK_SECRET: "whsec_community_not_configured",
    OPENCOMPANY_STRIPE_CHECKOUT_ENABLED: "false",
    INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    E2B_API_KEY: "community-disabled",
    VERCEL_AI_GATEWAY_API_KEY: "community-disabled",
    ELECTRIC_URL: "",
    REDIS_URL: "",
    OBSERVABILITY_ENABLED: "false",
    NEXT_PUBLIC_OBSERVABILITY_ENABLED: "false",
    BRAINTRUST_ENABLED: "false",
    STRIPE_LISTEN_DISABLED: "1",
  };
  delete env.PORT;
  delete env.ELECTRIC_SOURCE_ID;
  delete env.ELECTRIC_SOURCE_SECRET;
  delete env.ELECTRIC_SECRET;
  delete env.ELECTRIC_TOKEN;
  return env;
}

function communityDatabasePort(env) {
  const explicit = env.OPENCOMPANY_COMMUNITY_DATABASE_PORT?.trim();
  if (explicit) return validPort(explicit, "OPENCOMPANY_COMMUNITY_DATABASE_PORT");
  const conductorPort = env.CONDUCTOR_PORT?.trim();
  if (conductorPort) {
    const port = validPort(conductorPort, "CONDUCTOR_PORT") + 5;
    if (port > 65_535) throw new Error("CONDUCTOR_PORT leaves no port for community Postgres.");
    return port;
  }
  return 55_432;
}

function validPort(raw, name) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}
