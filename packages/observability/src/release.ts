// The commit a server process runs. Platform-supplied SHAs come first: Kamal sets KAMAL_VERSION
// to the release's `--version` (the commit SHA), Render sets RENDER_GIT_COMMIT and Vercel sets
// VERCEL_GIT_COMMIT_SHA. The release smoke compares /healthz `release` against the commit, so a
// configured OBSERVABILITY_RELEASE must never mask the platform value. Blank values are skipped
// because Kamal ships an unset secret as an empty string.
const RELEASE_ENV_KEYS = [
  "KAMAL_VERSION",
  "RENDER_GIT_COMMIT",
  "VERCEL_GIT_COMMIT_SHA",
  "OBSERVABILITY_RELEASE",
  "RELEASE_SHA",
  "GITHUB_SHA",
] as const;

type Env = Record<string, string | undefined>;

export function deployedRelease(env: Env | undefined = processEnv()): string | undefined {
  if (!env) return undefined;
  for (const key of RELEASE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function processEnv(): Env | undefined {
  return typeof process === "undefined" ? undefined : process.env;
}
