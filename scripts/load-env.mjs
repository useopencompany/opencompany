// Load Next.js-style env files: .env.local (gitignored, dev secrets) wins,
// .env (committed defaults, if any) fills gaps.
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
