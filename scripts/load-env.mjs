// Load repo env files. .env.override.local is a gitignored personal override
// for developer-owned resources and wins over the generated .env.local.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.OPENCOMPANY_LOAD_VERCEL_ENV === "1") {
  const vercelEnvPath =
    process.env.OPENCOMPANY_VERCEL_ENV_PATH?.trim() || ".vercel/.env.production.local";
  config({ path: join(repoRoot, vercelEnvPath), quiet: true });
}

config({ path: join(repoRoot, ".env.override.local"), quiet: true });
config({ path: join(repoRoot, ".env.local"), quiet: true });
config({ path: join(repoRoot, ".env"), quiet: true });
