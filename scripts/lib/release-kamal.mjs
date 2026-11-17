export const KAMAL_APPS = ["api", "runner"];

// The only job variables a `kamal deploy` inherits: what Ruby, Docker and SSH need to run, the
// ssh-agent holding the deploy key, and the GHCR login. Everything else comes from the app's own
// Infisical export (scripts/release-kamal-services.mjs explains why not the job env).
const JOB_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "RUNNER_TEMP",
  "CI",
  "GITHUB_ACTIONS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "KAMAL_REGISTRY_USERNAME",
  "KAMAL_REGISTRY_PASSWORD",
];

// Infisical/secrets-action v1.0.18 file export writes `KEY='value'` lines joined by newlines,
// without escaping. Values can hold quotes and newlines (the runner's PEMs do), so an entry ends
// only where the next `KEY='` line starts.
export function parseInfisicalEnvFile(text) {
  const secrets = {};
  if (text.trim() === "") return secrets;
  for (const entry of text.split(/\n(?=[A-Za-z_][A-Za-z0-9_]*=')/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)='([\s\S]*)'$/u.exec(entry);
    if (!match) throw new Error(`Unreadable Infisical export entry: ${entry.split("=")[0]}`);
    if (Object.hasOwn(secrets, match[1])) {
      throw new Error(`Infisical export lists ${match[1]} twice.`);
    }
    secrets[match[1]] = match[2];
  }
  return secrets;
}

// The env one `kamal deploy` runs with: the app's Infisical folder, which `.kamal/secrets` reads,
// plus the job variables above. `/electric` stays out: a deploy never boots the Electric accessory,
// so its `ELECTRIC_DATABASE_URL` ships empty and nothing reads it.
export function kamalDeployEnv({ app, jobEnv, appSecrets }) {
  if (!KAMAL_APPS.includes(app)) throw new Error(`Unknown Kamal app: ${app}`);
  const env = { ...appSecrets };
  // The job owns these keys, even when the app's folder also defines one.
  for (const key of JOB_ENV_KEYS) {
    delete env[key];
    if (jobEnv[key] !== undefined) env[key] = jobEnv[key];
  }
  for (const key of ["SSH_AUTH_SOCK", "KAMAL_REGISTRY_USERNAME", "KAMAL_REGISTRY_PASSWORD"]) {
    if (!env[key]?.trim()) throw new Error(`${key} is required to deploy ${app}.`);
  }
  return env;
}

export function kamalDeployArgs(releaseSha) {
  if (!/^[a-f0-9]{40}$/u.test(releaseSha)) {
    throw new Error(`RELEASE_SHA must be a full commit SHA, got ${releaseSha}.`);
  }
  // build-images pushed this tag. `kamal deploy` leaves a running Electric accessory alone, unlike
  // `kamal setup`, which would reboot it.
  return ["deploy", "--skip-push", "--version", releaseSha];
}
