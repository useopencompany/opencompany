import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { argv, exit, versions } from "node:process";

const CHECK_MODE = argv.includes("--check");
const PULL_ENV_MODE = argv.includes("--pull-env");
const START_DEV_MODE = argv.includes("--dev");
const SHARED_DATABASE_MODE =
  argv.includes("--shared-db") || process.env.OPENCOMPANY_SHARED_DATABASE === "1";

// .nvmrc pins this project to Node 22.
const MIN_NODE = [20, 20, 0];
const WORKOS_ENV_KEYS = [
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
  "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
];
const LINEAR_ENV_KEYS = [
  "LINEAR_API_KEY",
  "LINEAR_TEAM_ID",
  "LINEAR_FEEDBACK_PROJECT_ID",
  "LINEAR_FEEDBACK_LABELS",
];
const GITHUB_ENV_KEYS = [
  "OPENCOMPANY_GITHUB_ORG",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
];
const RUNNER_ENV_KEYS = [
  "RUNNER_PUBLIC_URL",
  "RUNNER_INTERNAL_URL",
  "RUNNER_INTERNAL_TOKEN",
  "RUNNER_STREAM_TOKEN_SECRET",
  "RUNNER_ALLOWED_ORIGINS",
  "E2B_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "EXA_API_KEY",
  "OPENCOMPANY_E2B_TEMPLATE",
  "RUNNER_E2B_IDLE_TIMEOUT_MS",
  "RUNNER_INSTANCE_ID",
];
const OBSERVABILITY_ENV_KEYS = [
  "BETTER_STACK_ERRORS_DSN",
  "OBSERVABILITY_ENABLED",
  "OBSERVABILITY_ENV",
  "OBSERVABILITY_RELEASE",
  "OBSERVABILITY_LOG_LEVEL",
  "OBSERVABILITY_TIMING",
  "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN",
  "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
  "NEXT_PUBLIC_OBSERVABILITY_ENV",
  "NEXT_PUBLIC_OBSERVABILITY_RELEASE",
  "NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL",
];
const OPTIONAL_SHARED_DEV_ENV_KEYS = [
  "NEON_PARENT_BRANCH",
  "NEON_API_KEY",
  "NEON_DATABASE_NAME",
  "NEON_ROLE_NAME",
  "NEON_BRANCH_NAME",
  "WORKOS_REDIRECT_URI",
  "PLAYWRIGHT_PORT",
  "NEXT_PUBLIC_POSTHOG_TOKEN",
  "NEXT_PUBLIC_POSTHOG_HOST",
  "NEXT_PUBLIC_ANALYTICS_DEBUG",
  ...LINEAR_ENV_KEYS,
  ...RUNNER_ENV_KEYS,
  ...OBSERVABILITY_ENV_KEYS,
];
const SHARED_DEV_ENV_KEYS = [...WORKOS_ENV_KEYS, ...GITHUB_ENV_KEYS];
const NEON_ENV_KEYS = ["NEON_PROJECT_ID"];
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
    databaseMode: SHARED_DATABASE_MODE ? "shared" : "branch",
    envFile: existsSync(".env.local") ? "exists" : "missing",
    nodeModules: existsSync("node_modules") ? "installed" : "missing",
    workos: workosMissing.length === 0 ? "ready" : "placeholder",
    workosMissingKeys: workosMissing,
    databaseUrl: isPlaceholder(env.DATABASE_URL) ? "placeholder" : "set",
    neonProject: isPlaceholder(env.NEON_PROJECT_ID) ? "placeholder" : "set",
    neonBranch: isPlaceholder(env.NEON_BRANCH) ? "placeholder" : "set",
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

function pullSharedDevEnvFromVercel({
  requireDatabaseUrl = false,
  requireNeonProject = false,
} = {}) {
  run("bunx", ["vercel", "env", "pull", VERCEL_ENV_PULL_PATH, "--yes"]);

  const pulled = parseEnv(VERCEL_ENV_PULL_PATH);
  rmSync(VERCEL_ENV_PULL_PATH, { force: true });

  const requiredKeys = [
    ...SHARED_DEV_ENV_KEYS,
    ...(requireNeonProject ? NEON_ENV_KEYS : []),
    ...(requireDatabaseUrl ? ["DATABASE_URL"] : []),
  ];
  const missing = requiredKeys.filter((key) => isPlaceholder(pulled[key]));
  if (missing.length > 0) {
    throw new Error(
      `Vercel Development env is missing shared setup values: ${missing.join(", ")}. ` +
        "Add them in Vercel, then run `bun run env:pull` again.",
    );
  }

  writeEnvValues(
    ".env.local",
    Object.fromEntries([
      ...requiredKeys.map((key) => [key, pulled[key]]),
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

  warn("WorkOS env vars in .env.local are still placeholders. Pulling from Vercel.");
  pullSharedDevEnvFromVercel({ requireNeonProject: !SHARED_DATABASE_MODE });

  const after = inspectState();
  if (after.workos !== "ready") {
    throw new Error(
      "Vercel env pull finished but .env.local still has placeholder WorkOS values. " +
        "Inspect .env.local and re-run setup.",
    );
  }
  ok("WorkOS configured");
}

async function ensureNeonProject(state) {
  if (SHARED_DATABASE_MODE) return;

  step("Neon project");
  if (state.neonProject === "set") {
    ok("NEON_PROJECT_ID is set");
    return;
  }

  warn("NEON_PROJECT_ID is missing from .env.local. Pulling from Vercel.");
  pullSharedDevEnvFromVercel({ requireNeonProject: true });

  const after = inspectState();
  if (after.neonProject !== "set") {
    throw new Error("Vercel env pull finished but NEON_PROJECT_ID is still missing.");
  }
  ok("Neon project configured");
}

async function ensureSharedDatabaseUrl(state) {
  step("Shared database URL");
  if (state.databaseUrl === "set") {
    ok("DATABASE_URL is set");
    return;
  }

  warn("DATABASE_URL is missing from .env.local. Pulling from Vercel.");
  pullSharedDevEnvFromVercel({ requireDatabaseUrl: true });

  const after = inspectState();
  if (after.databaseUrl !== "set") {
    throw new Error("Vercel env pull finished but DATABASE_URL is still missing.");
  }
  ok("DATABASE_URL configured");
}

async function ensureBranchDatabase() {
  step("Neon branch database");
  run("bun", ["run", "db:branch:create"]);

  const after = inspectState();
  if (after.databaseUrl !== "set" || after.neonBranch !== "set") {
    throw new Error(
      "Neon branch creation finished but DATABASE_URL or NEON_BRANCH is still missing.",
    );
  }
  ok("DATABASE_URL points at the Neon branch for this worktree");
}

async function runMigrations() {
  step("Run migrations");
  run("bun", ["run", "db:migrate"]);
}

async function main() {
  if (PULL_ENV_MODE) {
    console.log("\n\x1b[1mPull shared dev env\x1b[0m");
    await ensureEnvFile(inspectState());
    pullSharedDevEnvFromVercel({
      requireDatabaseUrl: SHARED_DATABASE_MODE,
      requireNeonProject: !SHARED_DATABASE_MODE,
    });
    ok("Updated .env.local with shared setup values from Vercel");
    return;
  }

  if (CHECK_MODE) {
    const state = inspectState();
    const nextSteps = [];
    if (state.envFile === "missing") {
      nextSteps.push({ command: "bun run setup", reason: "create .env.local" });
    }
    if (
      state.workos === "placeholder" ||
      (!SHARED_DATABASE_MODE && state.neonProject === "placeholder") ||
      (SHARED_DATABASE_MODE && state.databaseUrl === "placeholder")
    ) {
      const missingShared = [
        ...state.workosMissingKeys,
        ...(!SHARED_DATABASE_MODE && state.neonProject === "placeholder"
          ? ["NEON_PROJECT_ID"]
          : []),
        ...(SHARED_DATABASE_MODE && state.databaseUrl === "placeholder" ? ["DATABASE_URL"] : []),
      ];
      nextSteps.push({
        command: "bun run env:pull",
        reason: `pull shared development env vars from Vercel into .env.local (${missingShared.join(", ")})`,
      });
    }
    if (!SHARED_DATABASE_MODE && state.neonProject === "set") {
      nextSteps.push({
        command: "bun run db:branch:create",
        reason: "create or refresh the Neon branch DATABASE_URL for this Git branch",
      });
    }
    if (
      state.workos === "ready" &&
      (SHARED_DATABASE_MODE ? state.databaseUrl === "set" : state.neonProject === "set")
    ) {
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

  const state = inspectState();
  await ensureEnvFile(state);
  await ensureWorkOS(inspectState());
  if (SHARED_DATABASE_MODE) {
    await ensureSharedDatabaseUrl(inspectState());
  } else {
    await ensureNeonProject(inspectState());
    await ensureBranchDatabase();
  }
  await runMigrations();

  if (!START_DEV_MODE) {
    console.log("\n\x1b[1m\x1b[32m✓ All set.\x1b[0m Run \x1b[1mbun run dev\x1b[0m when ready.\n");
    return;
  }

  console.log(
    "\n\x1b[1m\x1b[32m✓ All set.\x1b[0m Starting \x1b[1mbun run dev\x1b[0m — open http://localhost:3000\n",
  );
  run("bun", ["run", "dev"]);
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ Setup failed:\x1b[0m ${err.message}\n`);
  exit(1);
});
