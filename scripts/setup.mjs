import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { argv, exit, versions } from "node:process";
import {
  caddyState,
  goatHttpsDisabled,
  goatHttpsOrigin,
  goatHttpsPort,
  homebrewAvailable,
  installCaddyWithHomebrew,
} from "./lib/caddy-dev.mjs";
import {
  directDatabaseUrl,
  dockerRunArgs,
  ELECTRIC_CONTAINER,
  ELECTRIC_HEALTH_URL,
  ELECTRIC_IMAGE,
  ELECTRIC_LOCAL_URL,
} from "./lib/electric-dev.mjs";

const CHECK_MODE = argv.includes("--check");
const PULL_ENV_MODE = argv.includes("--pull-env");
const START_DEV_MODE = argv.includes("--dev");
const STRIPE_MODE = argv.includes("--stripe");
const PERSONAL_ENV_MODE = argv.includes("--personal-env");
const SHARED_DATABASE_MODE =
  argv.includes("--shared-db") || process.env.OPENCOMPANY_SHARED_DATABASE === "1";
const PERSONAL_ENV_PATH = ".env.override.local";
const PERSONAL_ENV_TEMPLATE = `# Personal local overrides.
# This file is gitignored and has higher precedence than .env.local.
# Use it for developer-owned resources that should survive \`bun run env:pull\`.
#
# Personal Neon project for isolated local databases:
# NEON_PROJECT_ID=""
# NEON_API_KEY=""
# NEON_PARENT_BRANCH=""
# NEON_BRANCH_TTL_HOURS="24"
#
# Optional: point local workspace repos at a personal/dev GitHub org.
# OPENCOMPANY_GITHUB_ORG=""
`;

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
const GITHUB_WORK_INTEGRATION_ENV_KEYS = [
  "GITHUB_INTEGRATION_APP_ID",
  "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
  "GITHUB_INTEGRATION_APP_SLUG",
  "GITHUB_INTEGRATION_APP_CLIENT_ID",
  "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
  "GITHUB_INTEGRATION_STATE_SECRET",
];
const INTEGRATION_CREDENTIAL_ENV_KEYS = ["INTEGRATION_CREDENTIAL_ENCRYPTION_KEY"];
const GOOGLE_INTEGRATION_ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_INTEGRATION_STATE_SECRET",
];
const GOAT_X_INTEGRATION_ENV_KEYS = [
  "GOAT_X_CLIENT_ID",
  "GOAT_X_CLIENT_SECRET",
  "GOAT_X_STATE_SECRET",
];
const RUNNER_ENV_KEYS = [
  "RUNNER_PUBLIC_URL",
  "RUNNER_INTERNAL_URL",
  "RUNNER_LLM_BROKER_PUBLIC_URL",
  "RUNNER_INTERNAL_TOKEN",
  "RUNNER_STREAM_TOKEN_SECRET",
  "RUNNER_ALLOWED_ORIGINS",
  "E2B_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
  "EXA_API_KEY",
  "APIFY_API_TOKEN",
  "X_API_BEARER_TOKEN",
  "SUPADATA_API_KEY",
  "AMP_API_KEY",
  "OPENAI_CODEX_API_KEY",
  "OPENCOMPANY_E2B_TEMPLATE",
  "OPENCOMPANY_AMP_E2B_TEMPLATE",
  "RUNNER_E2B_IDLE_TIMEOUT_MS",
  "RUNNER_LLM_BROKER_ENABLED",
  "RUNNER_CODEX_MODEL",
  "RUNNER_CODEX_TIMEOUT_MS",
  "RUNNER_GOAT_CODEX_CHAT_IDLE_TIMEOUT_MS",
  "RUNNER_INSTANCE_ID",
];
const LOCAL_RUNNER_REQUIRED_ENV_KEYS = [
  "RUNNER_PUBLIC_URL",
  "RUNNER_INTERNAL_URL",
  "RUNNER_INTERNAL_TOKEN",
  "RUNNER_STREAM_TOKEN_SECRET",
  "E2B_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
];
const STRIPE_ENV_KEYS = ["STRIPE_SECRET_KEY"];
const STRIPE_OPTIONAL_ENV_KEYS = [
  "GOAT_STRIPE_API_KEY",
  "GOAT_STRIPE_WEBHOOK_SECRET",
  "GOAT_STRIPE_CHECKOUT_ENABLED",
  "CRON_SECRET",
  "STRIPE_LISTEN_DISABLED",
  "STRIPE_LISTEN_EVENTS",
  "STRIPE_CLI_PROJECT_NAME",
];
const GOAT_BILLING_LOCAL_ENV_KEYS = [
  "GOAT_STRIPE_API_KEY",
  "GOAT_STRIPE_WEBHOOK_SECRET",
  "GOAT_STRIPE_CHECKOUT_ENABLED",
  "CRON_SECRET",
];
const OBSERVABILITY_ENV_KEYS = [
  "BETTER_STACK_ERRORS_DSN",
  "OBSERVABILITY_ENABLED",
  "OBSERVABILITY_ENV",
  "OBSERVABILITY_RELEASE",
  "OBSERVABILITY_LOG_LEVEL",
  "OBSERVABILITY_TIMING",
  "BRAINTRUST_ENABLED",
  "BRAINTRUST_API_KEY",
  "BRAINTRUST_PROJECT_ID",
  "BRAINTRUST_PROJECT_NAME",
  "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN",
  "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
  "NEXT_PUBLIC_OBSERVABILITY_ENV",
  "NEXT_PUBLIC_OBSERVABILITY_RELEASE",
  "NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL",
];
const GOAT_OBSERVABILITY_ENV_KEYS = [
  "GOAT_OBSERVABILITY_ENABLED",
  "GOAT_OTEL_EXPORTER_OTLP_ENDPOINT",
  "GOAT_OTEL_EXPORTER_OTLP_HEADERS",
  "LATITUDE_API_KEY",
  "LATITUDE_PROJECT_SLUG",
  "LATITUDE_SERVICE_NAME",
  "LATITUDE_TELEMETRY_DISABLED",
];
const AGENT_MCP_ENV_KEYS = ["SIGNOZ_MCP_REGION", "SIGNOZ_MCP_URL"];
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
  "NEXT_PUBLIC_GOAT_POSTHOG_TOKEN",
  "NEXT_PUBLIC_GOAT_POSTHOG_HOST",
  "NEXT_PUBLIC_ANALYTICS_DEBUG",
  "OPENCOMPANY_NGROK_REQUIRED",
  "OPENCOMPANY_NGROK_URL",
  "NGROK_AUTHTOKEN",
  ...STRIPE_ENV_KEYS,
  ...STRIPE_OPTIONAL_ENV_KEYS,
  ...LINEAR_ENV_KEYS,
  ...RUNNER_ENV_KEYS,
  ...OBSERVABILITY_ENV_KEYS,
  ...GOAT_OBSERVABILITY_ENV_KEYS,
  ...AGENT_MCP_ENV_KEYS,
];
const SHARED_DEV_ENV_KEYS = [
  ...WORKOS_ENV_KEYS,
  ...GITHUB_ENV_KEYS,
  ...GITHUB_WORK_INTEGRATION_ENV_KEYS,
  ...INTEGRATION_CREDENTIAL_ENV_KEYS,
  ...GOOGLE_INTEGRATION_ENV_KEYS,
  ...GOAT_X_INTEGRATION_ENV_KEYS,
];
const NEON_ENV_KEYS = ["NEON_PROJECT_ID"];
const INFISICAL_DEV_ENV = "dev";
const INFISICAL_DEV_PATHS = ["/web", "/runner"];
const LOCAL_WORKOS_REDIRECT_URI = "http://localhost:3000/auth/callback";
const LEGACY_LOCAL_GOAT_APP_URL = "http://localhost:3002";
const LOCAL_GOAT_APP_URL = goatHttpsOrigin(process.env);
const LOCAL_GOAT_WORKOS_REDIRECT_URI = `${LOCAL_GOAT_APP_URL}/auth/callback`;
const GOAT_ENV_PATH = "apps/goat/.env.local";
const LOCAL_ONLY_ENV_KEYS = new Set([
  "DATABASE_URL",
  "NEON_BRANCH",
  "INNGEST_DEV",
  "OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS",
  "GOAT_PORT",
  "GOAT_HTTPS_PORT",
  "GOAT_NEXT_PUBLIC_APP_URL",
  "GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI",
  "RUNNER_LLM_BROKER_PUBLIC_URL",
]);
const LOCAL_DEV_DEFAULT_ENV_VALUES = {
  OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS: "louis@acta.so",
  GOAT_PORT: "3002",
  GOAT_HTTPS_PORT: goatHttpsPort(process.env),
  GOAT_NEXT_PUBLIC_APP_URL: LOCAL_GOAT_APP_URL,
  GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: LOCAL_GOAT_WORKOS_REDIRECT_URI,
  RUNNER_LLM_BROKER_PUBLIC_URL: "",
};
const GOAT_LOCAL_ENV_KEYS = [
  "GOAT_PORT",
  "GOAT_HTTPS_PORT",
  "DATABASE_URL",
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "WORKOS_COOKIE_PASSWORD",
  "RUNNER_PUBLIC_URL",
  "RUNNER_INTERNAL_URL",
  "RUNNER_INTERNAL_TOKEN",
  "GOAT_STRIPE_API_KEY",
  "GOAT_STRIPE_WEBHOOK_SECRET",
  "GOAT_STRIPE_CHECKOUT_ENABLED",
  "CRON_SECRET",
  ...GITHUB_WORK_INTEGRATION_ENV_KEYS,
  ...INTEGRATION_CREDENTIAL_ENV_KEYS,
  ...GOAT_X_INTEGRATION_ENV_KEYS,
  "ELECTRIC_URL",
  "ELECTRIC_SOURCE_ID",
  "ELECTRIC_SOURCE_SECRET",
  "ELECTRIC_SECRET",
  "ELECTRIC_TOKEN",
  "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
  "NEXT_PUBLIC_OBSERVABILITY_ENV",
  "NEXT_PUBLIC_OBSERVABILITY_RELEASE",
  "NEXT_PUBLIC_OBSERVABILITY_LOG_LEVEL",
  "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN",
  "NEXT_PUBLIC_GOAT_POSTHOG_TOKEN",
  "NEXT_PUBLIC_GOAT_POSTHOG_HOST",
  ...GOAT_OBSERVABILITY_ENV_KEYS,
];

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

function runCapture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    ...opts,
  });
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

function readEffectiveLocalEnv() {
  return {
    ...parseEnv(".env.local"),
    ...parseEnv(PERSONAL_ENV_PATH),
  };
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
  const env = readEffectiveLocalEnv();
  const workosMissing = WORKOS_ENV_KEYS.filter((k) => isPlaceholder(env[k]));
  const runnerMissing = LOCAL_RUNNER_REQUIRED_ENV_KEYS.filter((k) => isPlaceholder(env[k]));
  const githubIntegrationMissing = GITHUB_WORK_INTEGRATION_ENV_KEYS.filter((k) =>
    isPlaceholder(env[k]),
  );
  const goatBillingMissing = GOAT_BILLING_LOCAL_ENV_KEYS.filter((key) => isPlaceholder(env[key]));

  return {
    databaseMode: SHARED_DATABASE_MODE ? "shared" : "branch",
    envFile: existsSync(".env.local") ? "exists" : "missing",
    personalEnvFile: existsSync(PERSONAL_ENV_PATH) ? "exists" : "missing",
    nodeModules: existsSync("node_modules") ? "installed" : "missing",
    workos: workosMissing.length === 0 ? "ready" : "placeholder",
    workosMissingKeys: workosMissing,
    runner: runnerMissing.length === 0 ? "ready" : "placeholder",
    runnerMissingKeys: runnerMissing,
    githubIntegration: githubIntegrationMissing.length === 0 ? "ready" : "placeholder",
    githubIntegrationMissingKeys: githubIntegrationMissing,
    databaseUrl: isPlaceholder(env.DATABASE_URL) ? "placeholder" : "set",
    neonProject: isPlaceholder(env.NEON_PROJECT_ID) ? "placeholder" : "set",
    neonBranch: isPlaceholder(env.NEON_BRANCH) ? "placeholder" : "set",
    stripeSecretKey: isPlaceholder(env.STRIPE_SECRET_KEY) ? "placeholder" : "set",
    stripeWebhookSecret: isPlaceholder(env.STRIPE_WEBHOOK_SECRET) ? "placeholder" : "set",
    goatBilling: goatBillingMissing.length === 0 ? "ready" : "placeholder",
    goatBillingMissingKeys: goatBillingMissing,
  };
}

function unquoteStripeConfigValue(raw) {
  const value = raw.trim();
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseStripeConfigList(output) {
  let activeProjectName = "default";
  let currentProjectName = "";
  const projects = new Map();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      currentProjectName = unquoteStripeConfigValue(section[1]);
      if (!projects.has(currentProjectName)) {
        projects.set(currentProjectName, {});
      }
      continue;
    }

    const entry = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!entry) continue;

    const [, key, rawValue] = entry;
    const value = unquoteStripeConfigValue(rawValue);
    if (currentProjectName) {
      projects.get(currentProjectName)[key] = value;
    } else if (key === "project-name" && value) {
      activeProjectName = value;
    }
  }

  return { activeProjectName, projects };
}

function stripeCliProjectName() {
  return process.env.STRIPE_CLI_PROJECT_NAME?.trim();
}

function stripeCliArgs(args) {
  const projectName = stripeCliProjectName();
  return projectName ? ["--project-name", projectName, ...args] : args;
}

function readStripeSecretKeyFromCli() {
  const result = runCapture("stripe", stripeCliArgs(["config", "--list"]));
  if (result.error?.code === "ENOENT") {
    return { ok: false, message: "Stripe CLI is not installed or not on PATH." };
  }
  if (result.error) {
    return { ok: false, message: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message:
        result.stderr.trim() || "Stripe CLI could not read its config. Run `stripe login` first.",
    };
  }

  const config = parseStripeConfigList(result.stdout);
  const projectName = stripeCliProjectName() || config.activeProjectName;
  const project = config.projects.get(projectName);
  const key = project?.test_mode_api_key?.trim();
  if (!key || !/^(sk|rk)_test_/.test(key)) {
    return {
      ok: false,
      message: `Stripe CLI profile "${projectName}" has no test API key. Run \`stripe login\` first.`,
    };
  }

  return {
    ok: true,
    key,
    projectName,
    expiresAt: project?.test_mode_key_expires_at?.trim() || null,
  };
}

function readStripeWebhookSecretFromCli() {
  const result = runCapture("stripe", stripeCliArgs(["listen", "--print-secret"]), {
    timeout: 20_000,
  });
  if (result.error?.code === "ENOENT") {
    return { ok: false, message: "Stripe CLI is not installed or not on PATH." };
  }
  if (result.error) {
    return { ok: false, message: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message:
        result.stderr.trim() ||
        "Stripe CLI could not create a webhook signing secret. Run `stripe login` first.",
    };
  }

  const secret = result.stdout.trim();
  if (!/^whsec_/.test(secret)) {
    return {
      ok: false,
      message: "Stripe CLI returned an unexpected webhook signing secret format.",
    };
  }

  return { ok: true, secret };
}

function runStripeCliJson(args) {
  const result = runCapture("stripe", stripeCliArgs(args), { timeout: 20_000 });
  if (result.error?.code === "ENOENT") {
    return { ok: false, message: "Stripe CLI is not installed or not on PATH." };
  }
  if (result.error) return { ok: false, message: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      message: result.stderr.trim() || "Stripe CLI request failed. Run `stripe login` first.",
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, message: "Stripe CLI returned an unexpected response." };
  }
}

async function ensureEnvFile(state) {
  step("Local env file");
  const stagedEnvPath = ".env";
  const hasCloudStagedEnv =
    Boolean(process.env.E2B_SANDBOX_ID?.trim()) && existsSync(stagedEnvPath);

  if (state.envFile === "exists") {
    if (hasCloudStagedEnv) {
      const localEnv = parseEnv(".env.local");
      const stagedValues = Object.fromEntries(
        Object.entries(parseEnv(stagedEnvPath)).filter(([key]) => isPlaceholder(localEnv[key])),
      );
      if (Object.keys(stagedValues).length > 0) {
        writeEnvValues(".env.local", stagedValues);
        chmodSync(".env.local", 0o600);
        ok("Filled missing .env.local values from the staged cloud environment");
        return;
      }
    }
    ok(".env.local already exists");
    return;
  }
  if (hasCloudStagedEnv) {
    copyFileSync(stagedEnvPath, ".env.local");
    chmodSync(".env.local", 0o600);
    ok("Created .env.local from the staged cloud environment");
    return;
  }
  if (!existsSync(".env.example")) {
    throw new Error(".env.example is missing — can't seed .env.local");
  }
  copyFileSync(".env.example", ".env.local");
  ok("Created .env.local from .env.example");
}

async function ensureLocalDevDefaults() {
  const env = parseEnv(".env.local");
  const missingDefaults = Object.fromEntries(
    Object.entries(LOCAL_DEV_DEFAULT_ENV_VALUES).filter(
      ([key, value]) => !(key in env) || shouldReplaceLocalDefault(key, env[key], value),
    ),
  );

  if (Object.keys(missingDefaults).length === 0) return;

  writeEnvValues(".env.local", missingDefaults);
  ok(`Added local-only defaults: ${Object.keys(missingDefaults).join(", ")}`);
}

function shouldReplaceLocalDefault(key, current, next) {
  if (key === "GOAT_NEXT_PUBLIC_APP_URL") {
    return current === LEGACY_LOCAL_GOAT_APP_URL && next !== current;
  }
  if (key === "GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI") {
    return current === `${LEGACY_LOCAL_GOAT_APP_URL}/auth/callback` && next !== current;
  }
  return false;
}

async function ensureGoatEnvFile() {
  step("Goat app env file");

  const env = readEffectiveLocalEnv();
  const goatAppUrl = env.GOAT_NEXT_PUBLIC_APP_URL || LOCAL_GOAT_APP_URL;
  const goatRedirectUri = env.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI || `${goatAppUrl}/auth/callback`;
  const values = {
    GOAT_NEXT_PUBLIC_APP_URL: goatAppUrl,
    GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
    NEXT_PUBLIC_APP_URL: goatAppUrl,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
    WORKOS_REDIRECT_URI: goatRedirectUri,
  };

  for (const key of GOAT_LOCAL_ENV_KEYS) {
    if (!isPlaceholder(env[key])) {
      values[key] = env[key];
    }
  }

  writeEnvValues(GOAT_ENV_PATH, values);
  ok(
    `Updated ${GOAT_ENV_PATH} with Goat-local DB/Auth/runner/GitHub/Electric/observability/analytics env`,
  );
}

async function ensurePersonalEnvFile() {
  step("Personal env override file");
  if (existsSync(PERSONAL_ENV_PATH)) {
    ok(`${PERSONAL_ENV_PATH} already exists`);
    return;
  }

  writeFileSync(PERSONAL_ENV_PATH, PERSONAL_ENV_TEMPLATE);
  ok(`Created ${PERSONAL_ENV_PATH}`);
}

function canPullSharedDevEnvFromInfisical() {
  if (!existsSync(".infisical.json")) return false;

  const result = spawnSync("infisical", ["export", "--env", INFISICAL_DEV_ENV, "--path", "/web"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return result.status === 0;
}

function pullSharedDevEnvFromInfisical({
  requireDatabaseUrl = false,
  requireNeonProject = false,
} = {}) {
  const pulled = {};

  for (const path of INFISICAL_DEV_PATHS) {
    const result = spawnSync(
      "infisical",
      ["export", "--env", INFISICAL_DEV_ENV, "--path", path, "--format", "json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `infisical export failed for ${path}`);
    }

    for (const secret of JSON.parse(result.stdout || "[]")) {
      if (!secret?.key) continue;
      if (
        LOCAL_ONLY_ENV_KEYS.has(secret.key) &&
        !(secret.key === "DATABASE_URL" && requireDatabaseUrl)
      ) {
        continue;
      }
      pulled[secret.key] = secret.value;
    }
  }
  pulled.NEXT_PUBLIC_WORKOS_REDIRECT_URI = LOCAL_WORKOS_REDIRECT_URI;
  if (!isPlaceholder(pulled.WORKOS_REDIRECT_URI)) {
    pulled.WORKOS_REDIRECT_URI = LOCAL_WORKOS_REDIRECT_URI;
  }

  const requiredKeys = [
    ...SHARED_DEV_ENV_KEYS,
    ...LOCAL_RUNNER_REQUIRED_ENV_KEYS,
    ...(requireNeonProject ? NEON_ENV_KEYS : []),
    ...(requireDatabaseUrl ? ["DATABASE_URL"] : []),
  ];
  const missing = requiredKeys.filter((key) => isPlaceholder(pulled[key]));
  if (missing.length > 0) {
    throw new Error(
      `Infisical ${INFISICAL_DEV_ENV} env is missing shared setup values: ${missing.join(", ")}. ` +
        "Add them in Infisical, then run `bun run env:pull` again.",
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

function pullGoatBillingDevEnvFromInfisical() {
  if (!existsSync(".infisical.json")) return [];

  const current = readEffectiveLocalEnv();
  const missing = GOAT_BILLING_LOCAL_ENV_KEYS.filter((key) => isPlaceholder(current[key]));
  if (missing.length === 0) return [];

  const result = spawnSync(
    "infisical",
    ["export", "--env", INFISICAL_DEV_ENV, "--path", "/web", "--format", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) return [];

  const wanted = new Set(missing);
  const values = {};
  for (const secret of JSON.parse(result.stdout || "[]")) {
    if (wanted.has(secret?.key) && !isPlaceholder(secret.value)) {
      values[secret.key] = secret.value;
    }
  }
  if (Object.keys(values).length > 0) writeEnvValues(".env.local", values);
  return Object.keys(values);
}

function pullSharedDevEnv(options = {}) {
  if (canPullSharedDevEnvFromInfisical()) {
    pullSharedDevEnvFromInfisical(options);
    return "Infisical";
  }

  if (existsSync(".infisical.json")) {
    throw new Error(
      "Infisical is linked but shared dev env could not be pulled. " +
        "Run `infisical login` and check the dev /web and /runner folders.",
    );
  }

  throw new Error(
    "Infisical is not linked. Run `infisical login` and `infisical init`, then re-run setup.",
  );
}

async function ensureWorkOS(state) {
  step("WorkOS credentials");
  if (state.workos === "ready") {
    ok("WorkOS env vars look set");
    return;
  }

  warn("WorkOS env vars in .env.local are still placeholders. Pulling from Infisical.");
  const source = pullSharedDevEnv({
    requireNeonProject: !SHARED_DATABASE_MODE && state.neonProject !== "set",
  });

  const after = inspectState();
  if (after.workos !== "ready") {
    throw new Error(
      `${source} env pull finished but WorkOS values are still placeholders. ` +
        `Inspect .env.local and ${PERSONAL_ENV_PATH}, then re-run setup.`,
    );
  }
  ok(`WorkOS configured from ${source}`);
}

async function ensureNeonProject(state) {
  if (SHARED_DATABASE_MODE) return;

  step("Neon project");
  if (state.neonProject === "set") {
    ok("NEON_PROJECT_ID is set");
    return;
  }

  warn(
    `NEON_PROJECT_ID is missing from .env.local and ${PERSONAL_ENV_PATH}. Pulling from Infisical.`,
  );
  const source = pullSharedDevEnv({ requireNeonProject: true });

  const after = inspectState();
  if (after.neonProject !== "set") {
    throw new Error(`${source} env pull finished but NEON_PROJECT_ID is still missing.`);
  }
  ok(`Neon project configured from ${source}`);
}

async function ensureLocalRunnerEnv(state) {
  step("Runner local credentials");
  if (state.runner === "ready") {
    ok("Runner env vars look set");
    return;
  }

  warn(
    `Runner env vars in .env.local are still placeholders (${state.runnerMissingKeys.join(
      ", ",
    )}). Pulling from Infisical.`,
  );
  const source = pullSharedDevEnv({
    requireNeonProject: !SHARED_DATABASE_MODE && state.neonProject !== "set",
  });

  const after = inspectState();
  if (after.runner !== "ready") {
    throw new Error(
      `${source} env pull finished but runner values are still placeholders: ${after.runnerMissingKeys.join(
        ", ",
      )}. Add them in Infisical dev /runner, then run \`bun run env:pull\` again.`,
    );
  }
  ok(`Runner credentials configured from ${source}`);
}

async function ensureGitHubIntegrationEnv(state) {
  step("GitHub integration app credentials");
  if (state.githubIntegration === "ready") {
    ok("GitHub integration app env vars look set");
    return;
  }

  warn(
    `GitHub integration app env vars are missing (${state.githubIntegrationMissingKeys.join(
      ", ",
    )}). Pulling the shared main app credentials from Infisical.`,
  );
  const source = pullSharedDevEnv({
    requireNeonProject: !SHARED_DATABASE_MODE && state.neonProject !== "set",
  });

  const after = inspectState();
  if (after.githubIntegration !== "ready") {
    throw new Error(
      `${source} env pull finished but GitHub integration app values are still placeholders: ${after.githubIntegrationMissingKeys.join(
        ", ",
      )}. Add them in Infisical dev /web, then run \`bun run env:pull\` again.`,
    );
  }
  ok(`GitHub integration app credentials configured from ${source}`);
}

async function ensureSharedDatabaseUrl(state) {
  step("Shared database URL");
  if (state.databaseUrl === "set") {
    ok("DATABASE_URL is set");
    return;
  }

  warn(`DATABASE_URL is missing from .env.local and ${PERSONAL_ENV_PATH}. Pulling from Infisical.`);
  const source = pullSharedDevEnv({ requireDatabaseUrl: true });

  const after = inspectState();
  if (after.databaseUrl !== "set") {
    throw new Error(`${source} env pull finished but DATABASE_URL is still missing.`);
  }
  ok(`DATABASE_URL configured from ${source}`);
}

async function ensureStripe(state) {
  step("Stripe local credentials");

  const pulledGoatBillingKeys = pullGoatBillingDevEnvFromInfisical();
  if (pulledGoatBillingKeys.length > 0) {
    ok(`Loaded Goat billing values from Infisical dev: ${pulledGoatBillingKeys.join(", ")}`);
  }

  const updates = {};
  let cliCredentials;
  const getCliCredentials = () => {
    cliCredentials ??= readStripeSecretKeyFromCli();
    return cliCredentials;
  };
  let cliWebhookSecret;
  const getCliWebhookSecret = () => {
    cliWebhookSecret ??= readStripeWebhookSecretFromCli();
    return cliWebhookSecret;
  };
  if (state.stripeSecretKey === "set") {
    ok("STRIPE_SECRET_KEY is set");
  } else {
    const result = getCliCredentials();
    if (result.ok) {
      updates.STRIPE_SECRET_KEY = result.key;
      ok(`Will write STRIPE_SECRET_KEY from Stripe CLI profile "${result.projectName}"`);
    } else {
      warn(
        `STRIPE_SECRET_KEY is missing and could not be read from Stripe CLI: ${result.message} ` +
          "Credit checkout will fail until it is set.",
      );
    }
  }

  const env = { ...readEffectiveLocalEnv(), ...updates };
  if (isPlaceholder(env.GOAT_STRIPE_API_KEY)) {
    const result = getCliCredentials();
    if (result.ok && (result.key.startsWith("rk_test_") || result.expiresAt)) {
      updates.GOAT_STRIPE_API_KEY = result.key;
      if (result.key.startsWith("rk_test_")) {
        ok(`Will use restricted Stripe CLI profile "${result.projectName}" for local Goat billing`);
      } else {
        warn(
          `Will use the expiring Stripe CLI test key from profile "${result.projectName}" for local Goat billing only. Hosted environments still require a dedicated restricted key.`,
        );
      }
    } else if (result.ok) {
      warn(
        "Stripe CLI returned a non-restricted test key without an expiry. Run `stripe login` to refresh the CLI profile, or create a restricted test key for Goat billing and store it in Infisical dev /web.",
      );
    } else {
      warn(`GOAT_STRIPE_API_KEY is missing: ${result.message}`);
    }
  } else {
    ok("GOAT_STRIPE_API_KEY is set");
  }

  if (isPlaceholder(env.GOAT_STRIPE_CHECKOUT_ENABLED)) {
    updates.GOAT_STRIPE_CHECKOUT_ENABLED = "false";
    ok("Will keep live Goat Checkout disabled by default");
  }

  if (isPlaceholder(env.CRON_SECRET)) {
    updates.CRON_SECRET = randomBytes(32).toString("hex");
    ok("Will generate CRON_SECRET for local billing reconciliation");
  } else {
    ok("CRON_SECRET is set");
  }

  if (state.stripeWebhookSecret === "set") {
    ok("STRIPE_WEBHOOK_SECRET is set");
  } else {
    const result = getCliWebhookSecret();
    if (result.ok) {
      updates.STRIPE_WEBHOOK_SECRET = result.secret;
      ok("Will write STRIPE_WEBHOOK_SECRET from Stripe CLI");
    } else {
      warn(
        `STRIPE_WEBHOOK_SECRET is missing and could not be read from Stripe CLI: ${result.message} ` +
          "Forwarded Stripe webhooks will fail signature verification until it is set.",
      );
    }
  }

  const webhookEnv = { ...readEffectiveLocalEnv(), ...updates };
  if (isPlaceholder(webhookEnv.GOAT_STRIPE_WEBHOOK_SECRET)) {
    if (!isPlaceholder(webhookEnv.STRIPE_WEBHOOK_SECRET)) {
      updates.GOAT_STRIPE_WEBHOOK_SECRET = webhookEnv.STRIPE_WEBHOOK_SECRET;
      ok("Will mirror the local Stripe listener secret to GOAT_STRIPE_WEBHOOK_SECRET");
    } else {
      const result = getCliWebhookSecret();
      if (result.ok) {
        updates.GOAT_STRIPE_WEBHOOK_SECRET = result.secret;
        ok("Will write GOAT_STRIPE_WEBHOOK_SECRET from Stripe CLI");
      } else {
        warn(
          `GOAT_STRIPE_WEBHOOK_SECRET is missing and could not be read from Stripe CLI: ${result.message} ` +
            "Forwarded Stripe webhooks will fail signature verification until it is set.",
        );
      }
    }
  } else {
    ok("GOAT_STRIPE_WEBHOOK_SECRET is set");
  }

  if (Object.keys(updates).length > 0) {
    writeEnvValues(".env.local", updates);
    ok("Updated .env.local with local Stripe and Goat billing credentials");
  }
}

async function ensureBranchDatabase() {
  step("Neon branch database");
  if (process.env.E2B_SANDBOX_ID?.trim()) {
    run("bun", ["run", "db:cloud-base:refresh"]);
  }
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
  const databaseUrl = readEffectiveLocalEnv().DATABASE_URL;
  if (isPlaceholder(databaseUrl)) {
    throw new Error("DATABASE_URL is missing after Neon branch setup.");
  }
  run("bun", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

// Like run(), but returns the exit code instead of throwing so a failed Docker
// step degrades to a warning rather than aborting the whole setup.
function runAllowFail(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", timeout: 180_000, ...opts });
  return result.status ?? 1;
}

// "missing" = no Docker CLI; "stopped" = CLI present but engine not running;
// "ready" = engine responds. OrbStack and Docker Desktop both expose `docker`.
function dockerState() {
  const probe = runCapture("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (probe.error?.code === "ENOENT") return "missing";
  return probe.status === 0 ? "ready" : "stopped";
}

// A container runtime is a hard requirement for local dev: the agents/sessions
// UI reads through a local Electric container, so without it the app's lists
// 503. Fail fast with actionable instructions rather than limping on.
function assertDocker() {
  const state = dockerState();
  if (state === "ready") return;

  const reason =
    state === "stopped"
      ? "Docker is installed but its engine isn't running."
      : "No container runtime found.";
  const action =
    state === "stopped"
      ? "  Start the engine, then re-run \x1b[1mbun run setup\x1b[0m:\n\n" +
        "    \x1b[1mopen -a OrbStack\x1b[0m   # or launch Docker Desktop"
      : "  Install \x1b[1mOrbStack\x1b[0m (lightweight on macOS), start it, then re-run \x1b[1mbun run setup\x1b[0m:\n\n" +
        "    \x1b[1mbrew install orbstack\x1b[0m   # or download from https://orbstack.dev\n" +
        "    \x1b[1mopen -a OrbStack\x1b[0m        # start the engine — required, or Docker won't respond\n\n" +
        "  (Docker Desktop also works.)";

  console.error(
    `\n\x1b[31m✗ ${reason}\x1b[0m\n` +
      "  Local dev needs Electric, which runs as a local container, so a container\n" +
      "  runtime is required.\n\n" +
      `${action}\n\n` +
      "  One-time: also enable \x1b[1mlogical replication\x1b[0m on the Neon project\n" +
      "  (console → Settings) so Electric can replicate. See docs/stack/electric-sync.md.\n",
  );
  exit(1);
}

async function waitForElectricHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ELECTRIC_HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) return true;
    } catch {
      // Not accepting requests yet — keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

// Bring up the local Electric sync container so the agents/sessions UI has its
// data source. The read layer is fully Electric-backed, so without this the
// shape proxy 503s. Assumes the container runtime is present (assertDocker()
// gates the setup run); an unhealthy container is a warning, not a failure.
async function ensureElectric() {
  step("Electric sync (local)");

  const databaseUrl = directDatabaseUrl(readEffectiveLocalEnv());
  if (!databaseUrl) {
    warn("No DATABASE_URL yet — skipping Electric. Re-run setup once the database is configured.");
    return;
  }

  // Pull up front (no-op if cached) so the first dev run doesn't stall on it.
  if (runAllowFail("docker", ["pull", ELECTRIC_IMAGE]) !== 0) {
    warn(`Could not pull ${ELECTRIC_IMAGE}. Check your network, then re-run setup.`);
    return;
  }

  // Recreate so the container always tracks the current branch's DATABASE_URL.
  spawnSync("docker", ["rm", "-f", ELECTRIC_CONTAINER], { stdio: "ignore" });
  if (runAllowFail("docker", dockerRunArgs(databaseUrl, { detached: true })) !== 0) {
    warn(`Failed to start the Electric container "${ELECTRIC_CONTAINER}".`);
    return;
  }

  writeEnvValues(".env.local", { ELECTRIC_URL: ELECTRIC_LOCAL_URL });

  if (await waitForElectricHealth()) {
    ok(
      `Electric live at ${ELECTRIC_LOCAL_URL} (container "${ELECTRIC_CONTAINER}"); set ELECTRIC_URL`,
    );
    return;
  }

  // Container is up but not serving — almost always logical replication is off.
  warn(
    "Electric started but isn't healthy yet. The usual cause is logical replication not being\n" +
      "    enabled on the Neon project (console → Settings → enable logical replication).\n" +
      `    ELECTRIC_URL is set; inspect with: docker logs --tail 40 ${ELECTRIC_CONTAINER}`,
  );
  const logs = runCapture("docker", ["logs", "--tail", "20", ELECTRIC_CONTAINER]);
  const out = `${logs.stdout ?? ""}${logs.stderr ?? ""}`.trim();
  if (out) {
    console.log(
      out
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n"),
    );
  }
}

async function ensureGoatLocalHttps() {
  step("Goat local HTTPS");

  if (goatHttpsDisabled(process.env)) {
    warn("OPENCOMPANY_GOAT_HTTPS_DISABLED is set; Goat local dev will use HTTP.");
    return;
  }

  let state = caddyState();
  if (!state.available && process.platform === "darwin" && homebrewAvailable()) {
    warn("Caddy is not installed. Installing it with Homebrew for Goat local HTTPS/HTTP2.");
    const install = installCaddyWithHomebrew();
    if (install.status === 0) {
      state = caddyState();
    } else {
      warn("Homebrew could not install Caddy. `bun run dev:goat` will fall back to HTTP.");
      return;
    }
  }

  if (!state.available) {
    warn(
      "Caddy is not installed. Install it with `brew install caddy` " +
        "to enable Goat local HTTPS/HTTP2.",
    );
    return;
  }

  ok(`Caddy is installed; dev:goat will serve Goat at ${goatHttpsOrigin(process.env)}`);
}

async function main() {
  if (PERSONAL_ENV_MODE) {
    console.log("\n\x1b[1mPersonal env override\x1b[0m");
    await ensurePersonalEnvFile();
    console.log(
      `\nAdd personal values to \x1b[1m${PERSONAL_ENV_PATH}\x1b[0m, then run \x1b[1mbun run setup\x1b[0m.\n`,
    );
    return;
  }

  if (PULL_ENV_MODE) {
    console.log("\n\x1b[1mPull shared dev env\x1b[0m");
    await ensureEnvFile(inspectState());
    const state = inspectState();
    const source = pullSharedDevEnv({
      requireDatabaseUrl: SHARED_DATABASE_MODE,
      requireNeonProject: !SHARED_DATABASE_MODE && state.neonProject !== "set",
    });
    await ensureLocalDevDefaults();
    await ensureGoatEnvFile();
    ok(`Updated .env.local with shared setup values from ${source}`);
    return;
  }

  if (STRIPE_MODE) {
    console.log("\n\x1b[1mStripe local credentials\x1b[0m");
    await ensureEnvFile(inspectState());
    await ensureLocalDevDefaults();
    await ensureStripe(inspectState());
    await ensureGoatEnvFile();
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
      state.runner === "placeholder" ||
      state.githubIntegration === "placeholder" ||
      (!SHARED_DATABASE_MODE && state.neonProject === "placeholder") ||
      (SHARED_DATABASE_MODE && state.databaseUrl === "placeholder")
    ) {
      const missingShared = [
        ...state.workosMissingKeys,
        ...state.runnerMissingKeys,
        ...state.githubIntegrationMissingKeys,
        ...(!SHARED_DATABASE_MODE && state.neonProject === "placeholder"
          ? ["NEON_PROJECT_ID"]
          : []),
        ...(SHARED_DATABASE_MODE && state.databaseUrl === "placeholder" ? ["DATABASE_URL"] : []),
      ];
      nextSteps.push({
        command: "bun run env:pull",
        reason: `pull shared development env vars into .env.local (${missingShared.join(", ")})`,
      });
    }
    if (state.stripeSecretKey === "placeholder" || state.stripeWebhookSecret === "placeholder") {
      const missingStripe = [
        ...(state.stripeSecretKey === "placeholder" ? ["STRIPE_SECRET_KEY"] : []),
        ...(state.stripeWebhookSecret === "placeholder" ? ["STRIPE_WEBHOOK_SECRET"] : []),
      ];
      nextSteps.push({
        command: "bun run setup:stripe",
        reason: `copy local Stripe CLI credentials into .env.local (${missingStripe.join(", ")})`,
      });
    }
    if (state.goatBilling === "placeholder") {
      nextSteps.push({
        command: "bun run setup:stripe",
        reason: `configure local Goat billing (${state.goatBillingMissingKeys.join(", ")})`,
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
    const electric = dockerState();
    const caddy = caddyState();
    const electricUrlSet = !isPlaceholder(readEffectiveLocalEnv().ELECTRIC_URL);
    if (electric === "missing") {
      nextSteps.push({
        command: "brew install orbstack",
        reason:
          "install a container runtime so setup can start local Electric (the agents/sessions UI reads through it and 503s without it)",
      });
    } else if (electric === "stopped") {
      nextSteps.push({
        command: "open -a OrbStack",
        reason: "start the Docker engine so `bun run setup` can bring up local Electric",
      });
    } else if (!electricUrlSet) {
      nextSteps.push({
        command: "bun run setup",
        reason: "start local Electric and set ELECTRIC_URL for live agents/sessions sync",
      });
    }
    if (!existsSync(GOAT_ENV_PATH)) {
      nextSteps.push({
        command: "bun run setup",
        reason: `write ${GOAT_ENV_PATH} for direct Goat app local tooling`,
      });
    }
    if (!goatHttpsDisabled(process.env) && !caddy.available) {
      nextSteps.push({
        command: "bun run setup",
        reason: "install/check Caddy so `bun run dev:goat` serves local Goat over HTTPS/HTTP2",
      });
    }
    console.log(
      JSON.stringify(
        {
          ...state,
          electric,
          electricUrl: electricUrlSet ? "set" : "placeholder",
          caddy: caddy.available ? "ready" : "missing",
          goatLocalHttps: goatHttpsDisabled(process.env)
            ? "disabled"
            : goatHttpsOrigin(process.env),
          nextSteps,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("\n\x1b[1mProject setup\x1b[0m");
  console.log("Wiring up your local env and running migrations.\n");

  // Hard prerequisite — fail fast before touching env/db if the runtime that
  // local Electric needs isn't available.
  assertDocker();

  const state = inspectState();
  await ensureEnvFile(state);
  await ensureLocalDevDefaults();
  await ensureWorkOS(inspectState());
  await ensureLocalRunnerEnv(inspectState());
  await ensureGitHubIntegrationEnv(inspectState());
  if (SHARED_DATABASE_MODE) {
    await ensureSharedDatabaseUrl(inspectState());
  } else {
    await ensureNeonProject(inspectState());
    await ensureBranchDatabase();
  }
  await ensureStripe(inspectState());
  await runMigrations();
  await ensureElectric();
  await ensureGoatLocalHttps();
  await ensureGoatEnvFile();

  if (!START_DEV_MODE) {
    console.log(
      "\n\x1b[1m\x1b[32m✓ All set.\x1b[0m Run \x1b[1mbun run dev\x1b[0m or \x1b[1mbun run dev:goat\x1b[0m when ready.\n",
    );
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
