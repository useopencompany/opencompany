import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";

const CHECK_MODE = argv.includes("--check");
const NON_INTERACTIVE = CHECK_MODE || argv.includes("--non-interactive");

const rl = NON_INTERACTIVE ? null : createInterface({ input: stdin, output: stdout });
const ask = (q) => (rl ? rl.question(q) : Promise.resolve(""));

function step(label) {
  if (CHECK_MODE) return;
  console.log(`\n\x1b[1m▸ ${label}\x1b[0m`);
}
function ok(msg) {
  if (CHECK_MODE) return;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function warn(msg) {
  if (CHECK_MODE) return;
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`);
  }
}

function parseEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function isPlaceholder(value) {
  if (!value) return true;
  return (
    value.includes("...") ||
    value.startsWith("replace-") ||
    value === "" ||
    value === "postgresql://..."
  );
}

function hasNeonAuth() {
  const candidates = [
    join(homedir(), ".config", "neonctl", "credentials.json"),
    join(homedir(), ".neon", "credentials.json"),
  ];
  return candidates.some(existsSync);
}

function inspectState() {
  const env = parseEnv(".env.local");
  const workosKeys = ["WORKOS_CLIENT_ID", "WORKOS_API_KEY", "WORKOS_COOKIE_PASSWORD"];
  const workosMissing = workosKeys.filter((k) => isPlaceholder(env[k]));

  return {
    envFile: existsSync(".env.local") ? "exists" : "missing",
    nodeModules: existsSync("node_modules") ? "installed" : "missing",
    workos: workosMissing.length === 0 ? "ready" : "placeholder",
    workosMissingKeys: workosMissing,
    neonAuth: process.env.NEON_API_KEY
      ? "api-key"
      : hasNeonAuth()
        ? "authed"
        : "missing",
    databaseUrl: isPlaceholder(env.DATABASE_URL) ? "placeholder" : "set",
    neonBranch: env.NEON_BRANCH || null,
  };
}

async function ensureEnvFile(state) {
  step("Local env file");
  if (state.envFile === "exists") {
    ok(".env.local already exists");
    return;
  }
  if (!existsSync(".env.example")) {
    throw new Error(".env.example is missing — can't seed .env.local");
  }
  copyFileSync(".env.example", ".env.local");
  ok("Created .env.local from .env.example");
}

async function ensureWorkOS(state) {
  step("WorkOS credentials");
  if (state.workos === "ready") {
    ok("WorkOS env vars look set");
    return;
  }

  warn("WorkOS env vars in .env.local are still placeholders.");
  console.log(
    "\n  The WorkOS CLI can provision a temporary dev environment for you — no\n" +
      "  signup needed — and write the keys straight into .env.local.",
  );

  const answer = (await ask("\n  Run `bunx workos@latest install` now? [Y/n] "))
    .trim()
    .toLowerCase();

  if (answer === "n" || answer === "no") {
    console.log(
      "\n  Skipping. Either run `bunx workos@latest install` yourself, or paste\n" +
        "  keys from https://dashboard.workos.com into .env.local manually.\n" +
        "  Generate WORKOS_COOKIE_PASSWORD with `openssl rand -base64 32`.\n" +
        "  Then re-run `bun run setup`.",
    );
    exit(0);
  }

  run("bunx", [
    "workos@latest",
    "install",
    "--integration",
    "next",
    "--redirect-uri",
    "http://localhost:3000/auth/callback",
    "--no-branch",
    "--no-commit",
  ]);

  // Re-check after install
  const after = inspectState();
  if (after.workos !== "ready") {
    throw new Error(
      "WorkOS installer finished but .env.local still has placeholder values. " +
        "Inspect .env.local and re-run setup.",
    );
  }
  ok("WorkOS configured");
}

async function ensureNeonAuth(state) {
  step("Neon authentication");
  if (state.neonAuth !== "missing") {
    ok(
      state.neonAuth === "api-key"
        ? "NEON_API_KEY is set — skipping browser login"
        : "Already authenticated with Neon",
    );
    return;
  }
  if (NON_INTERACTIVE) {
    throw new Error("Neon auth missing and we're non-interactive. Run `bunx neonctl auth` first.");
  }
  console.log("  Launching browser to log in to Neon...");
  run("bunx", ["neonctl", "auth"]);
  ok("Authenticated with Neon");
}

async function createBranchAndMigrate() {
  step("Create Neon branch for this Git branch");
  run("bun", ["run", "db:branch:create"]);

  step("Run migrations");
  run("bun", ["run", "db:migrate"]);
}

async function maybeSeed() {
  step("Seed dev data (optional)");
  if (NON_INTERACTIVE) {
    ok("Skipped (non-interactive)");
    return;
  }
  const answer = (await ask("  Seed a dev user + workspace? [y/N] ")).trim().toLowerCase();
  if (answer === "y" || answer === "yes") {
    run("bun", ["run", "db:seed"]);
    ok("Seeded");
  } else {
    ok("Skipped seed");
  }
}

async function main() {
  if (CHECK_MODE) {
    const state = inspectState();
    const nextSteps = [];
    if (state.envFile === "missing") {
      nextSteps.push({ command: "bun run setup", reason: "create .env.local" });
    }
    if (state.workos === "placeholder") {
      nextSteps.push({
        command: "bun run setup",
        reason: "provision WorkOS via `bunx workos@latest install` (interactive)",
      });
    }
    if (state.neonAuth === "missing") {
      nextSteps.push({
        command: "bunx neonctl auth",
        reason: "browser login to Neon (interactive)",
      });
    }
    if (state.workos === "ready" && state.neonAuth !== "missing" && state.databaseUrl === "placeholder") {
      nextSteps.push({
        command: "bun run db:branch:create && bun run db:migrate",
        reason: "create per-branch DB and apply migrations (non-interactive, safe for agent)",
      });
    }
    console.log(JSON.stringify({ ...state, nextSteps }, null, 2));
    return;
  }

  console.log("\n\x1b[1mProject setup\x1b[0m");
  console.log("Wiring up your local env, Neon branch DB, and migrations.\n");

  try {
    const state = inspectState();
    await ensureEnvFile(state);
    await ensureWorkOS(inspectState());
    await ensureNeonAuth(inspectState());
    await createBranchAndMigrate();
    await maybeSeed();

    console.log(
      "\n\x1b[1m\x1b[32m✓ All set.\x1b[0m Run \x1b[1mbun run dev\x1b[0m and open http://localhost:3000\n",
    );
  } finally {
    rl?.close();
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ Setup failed:\x1b[0m ${err.message}\n`);
  rl?.close();
  exit(1);
});
