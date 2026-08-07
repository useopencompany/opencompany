const EXPECTED_RELEASE_ENV = {
  app: "EXPECTED_APP_RELEASE",
  runner: "EXPECTED_RUNNER_RELEASE",
};

export function expectedReleaseFor(surface, env = process.env) {
  const variable = EXPECTED_RELEASE_ENV[surface];
  if (!variable) {
    throw new Error(`Unknown smoke-check surface: ${surface}`);
  }

  if (Object.hasOwn(env, variable)) {
    return env[variable]?.trim() || "";
  }

  return env.EXPECTED_RELEASE?.trim() || "";
}
