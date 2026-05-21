import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

config({ path: join(repoRoot, ".env.local"), quiet: true });
config({ path: join(repoRoot, ".env"), quiet: true });
