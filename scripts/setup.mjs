import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { argv, exit, stdin, stdout, versions } from "node:process";
import { createInterface } from "node:readline/promises";

const CHECK_MODE = argv.includes("--check");
const PULL_ENV_MODE = argv.includes("--pull-env");
const NON_INTERACTIVE = CHECK_MODE || PULL_ENV_MODE || argv.includes("--non-interactive");

// .nvmrc pins this project to Node 22.
const MIN_NODE = [20, 20, 0];
const WORKOS_ENV_KEYS = [
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
  "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
];
const OPTIONAL_SHARED_DEV_ENV_KEYS = [
  "NEXT_PUBLIC_POSTHOG_TOKEN",
  "NEXT_PUBLIC_POSTHOG_HOST",
  "NEXT_PUBLIC_ANALYTICS_DEBUG",
];
const SHARED_DEV_ENV_KEYS = [...WORKOS_ENV_KEYS, "DATABASE_URL"];
const VERCEL_ENV_PULL_PATH = ".env.vercel.local";

function assertNodeVersion() {
  const current = versions.node.split(".").map(Number);
  const tooOld =
    current[0] < MIN_NODE[0] ||
    (current[0] === MIN_NODE[0] && current[1] < MIN_NODE[1]) ||
    (current[0] === MIN_NODE[0] && current[1] === MIN_NODE[1] && current[2] < MIN_NODE[2]);
  if (!tooOld) return;
  if (CHECK_MODE) {
    console.log(
      JSON.stringify(
        {
          node: `v${versions.node}`,
          required: `>=${MIN_NODE.join(".")}`,
          nextSteps: [
            {
              command: "nvm install && nvm use",
              reason: `upgrade Node — .nvmrc pins this project to Node 22 (current: v${versions.node})`,
            },
          ],
        },
        null,
        2,
      ),
    );
    exit(1);
  }
  console.error(
    `\n\x1b[31m✗ Node ${versions.node} is too old.\x1b[0m This project\n` +
      `  require Node >=${MIN_NODE.join(".")}. An \x1b[1m.nvmrc\x1b[0m pins it to Node 22.\n\n` +
      `  Run:\n    \x1b[1mnvm install\x1b[0m   # one-time, installs the version from .nvmrc\n` +
      `    \x1b[1mnvm use\x1b[0m       # switch this shell to it\n` +
      `  then re-run \x1b[1mbun run setup\x1b[0m.\n`,
  );
  exit(1);
}

assertNodeVersion();

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

function formatEnvValue(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function writeEnvValues(path, values) {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${formatEnvValue(values[match[1]])}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${formatEnvValue(value)}`);
  }

  writeFileSync(
    path,
    `${next.filter((line, index) => line !== "" || index < next.length - 1).join("\n")}\n`,
  );
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

function inspectState() {
  const env = parseEnv(".env.local");
  const workosMissing = WORKOS_ENV_KEYS.filter((k) => isPlaceholder(env[k]));

  return {
    envFile: existsSync(".env.local") ? "exists" : "missing",
    nodeModules: existsSync("node_modules") ? "installed" : "missing",
    workos: workosMissing.length === 0 ? "ready" : "placeholder",
    workosMissingKeys: workosMissing,
    databaseUrl: isPlaceholder(env.DATABASE_URL) ? "placeholder" : "set",
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

function pullSharedDevEnvFromVercel() {
  run("bunx", ["vercel", "env", "pull", VERCEL_ENV_PULL_PATH, "--yes"]);

  const pulled = parseEnv(VERCEL_ENV_PULL_PATH);
  rmSync(VERCEL_ENV_PULL_PATH, { force: true });

  const missing = SHARED_DEV_ENV_KEYS.filter((key) => isPlaceholder(pulled[key]));
  if (missing.length > 0) {
    throw new Error(
      `Vercel Development env is missing shared setup values: ${missing.join(", ")}. ` +
        "Add them in Vercel, then run `bun run env:pull` again.",
    );
  }

  writeEnvValues(
    ".env.local",
    Object.fromEntries([
      ...SHARED_DEV_ENV_KEYS.map((key) => [key, pulled[key]]),
      ...OPTIONAL_SHARED_DEV_ENV_KEYS.filter((key) => !isPlaceholder(pulled[key])).map((key) => [
        key,
        pulled[key],
      ]),
    ]),
  );
}

async function ensureWorkOS(state) {
  step("WorkOS credentials");
  if (state.workos === "ready") {
    ok("WorkOS env vars look set");
    return;
  }

  warn("WorkOS env vars in .env.local are still placeholders.");
  console.log(
    "\n  Pull the shared Development env from Vercel. This preserves local-only\n" +
      "  values like DATABASE_URL while filling the WorkOS AuthKit keys.",
  );

  if (NON_INTERACTIVE) {
    throw new Error(
      "WorkOS env vars are missing. Run `bun run env:pull` or fill .env.local manually.",
    );
  }

  const answer = (await ask("\n  Run `bun run env:pull` now? [Y/n] ")).trim().toLowerCase();

  if (answer === "n" || answer === "no") {
    console.log(
      "\n  Skipping. Run `bunx vercel link` if this checkout is not linked, then\n" +
        "  `bun run env:pull`, or paste keys from https://dashboard.workos.com\n" +
        "  into .env.local manually.\n" +
        "  Generate WORKOS_COOKIE_PASSWORD with `openssl rand -base64 32`.\n" +
        "  Then re-run `bun run setup`.",
    );
    exit(0);
  }

  pullSharedDevEnvFromVercel();

  // Re-check after pulling shared env.
  const after = inspectState();
  if (after.workos !== "ready") {
    throw new Error(
      "Vercel env pull finished but .env.local still has placeholder WorkOS values. " +
        "Inspect .env.local and re-run setup.",
    );
  }
  ok("WorkOS configured");
}

async function ensureDatabaseUrl(state) {
  step("Database URL");
  if (state.databaseUrl === "set") {
    ok("DATABASE_URL is set");
    return;
  }

  warn("DATABASE_URL is missing from .env.local.");
  console.log(
    "\n  Pull the shared Development env from Vercel to fill DATABASE_URL\n" +
      "  alongside the WorkOS keys.",
  );

  if (NON_INTERACTIVE) {
    throw new Error("DATABASE_URL is missing. Run `bun run env:pull` or fill .env.local manually.");
  }

  const answer = (await ask("\n  Run `bun run env:pull` now? [Y/n] ")).trim().toLowerCase();

  if (answer === "n" || answer === "no") {
    console.log(
      "\n  Skipping. Set DATABASE_URL in .env.local, or add it to Vercel\n" +
        "  Development and run `bun run env:pull`. Then re-run `bun run setup`.",
    );
    exit(0);
  }

  pullSharedDevEnvFromVercel();

  const after = inspectState();
  if (after.databaseUrl !== "set") {
    throw new Error("Vercel env pull finished but DATABASE_URL is still missing.");
  }
  ok("DATABASE_URL configured");
}

async function runMigrations() {
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
  if (PULL_ENV_MODE) {
    console.log("\n\x1b[1mPull shared dev env\x1b[0m");
    await ensureEnvFile(inspectState());
    pullSharedDevEnvFromVercel();
    ok("Updated .env.local with shared setup values from Vercel");
    return;
  }

  if (CHECK_MODE) {
    const state = inspectState();
    const nextSteps = [];
    if (state.envFile === "missing") {
      nextSteps.push({ command: "bun run setup", reason: "create .env.local" });
    }
    if (state.workos === "placeholder" || state.databaseUrl === "placeholder") {
      const missingShared = [
        ...state.workosMissingKeys,
        ...(state.databaseUrl === "placeholder" ? ["DATABASE_URL"] : []),
      ];
      nextSteps.push({
        command: "bun run env:pull",
        reason: `pull shared development env vars from Vercel into .env.local (${missingShared.join(", ")})`,
      });
    }
    if (state.workos === "ready" && state.databaseUrl === "set") {
      nextSteps.push({
        command: "bun run db:migrate",
        reason: "apply migrations against the configured DATABASE_URL",
      });
    }
    console.log(JSON.stringify({ ...state, nextSteps }, null, 2));
    return;
  }

  console.log("\n\x1b[1mProject setup\x1b[0m");
  console.log("Wiring up your local env and running migrations.\n");

  try {
    const state = inspectState();
    await ensureEnvFile(state);
    await ensureWorkOS(inspectState());
    await ensureDatabaseUrl(inspectState());
    await runMigrations();
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
