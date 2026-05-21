import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { env, exit } from "node:process";

const port = env.PORT || "3000";
const sdkUrl = env.INNGEST_SDK_URL || `http://localhost:${port}/api/inngest`;
const args = [
  "--yes",
  "--ignore-scripts=false",
  "inngest-cli@latest",
  "dev",
  "--sdk-url",
  sdkUrl,
];

const result = spawnSync("npx", args, {
  env: {
    ...env,
    INNGEST_DEV: env.INNGEST_DEV || "1",
  },
  stdio: "inherit",
});

exit(result.status ?? 1);
