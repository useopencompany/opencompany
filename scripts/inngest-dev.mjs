// Called by: @opencompany/inngest-dev `bun run dev`, usually through the root dev stack.
// Purpose: starts the local Inngest dev server against the web app SDK endpoint.

import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { env, exit } from "node:process";

const port = env.PORT || "3000";
const sdkUrl = env.INNGEST_SDK_URL || `http://localhost:${port}/api/inngest`;
const args = ["--yes", "--ignore-scripts=false", "inngest-cli@latest", "dev", "--sdk-url", sdkUrl];

const result = spawnSync("npx", args, {
  env: {
    ...env,
    INNGEST_DEV: "1",
  },
  stdio: "inherit",
});

exit(result.status ?? 1);
