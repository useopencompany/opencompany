// Load Next.js-style env files: .env.local (gitignored, dev secrets) wins,
// .env (committed defaults, if any) fills gaps.
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

config({ path: join(repoRoot, ".env.local"), quiet: true });
config({ path: join(repoRoot, ".env"), quiet: true });
