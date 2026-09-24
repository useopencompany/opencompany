const EXPECTED_RELEASE_ENV = {
  web: "EXPECTED_WEB_RELEASE",
  api: "EXPECTED_API_RELEASE",
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

export function webHealthTargets({ webUrl = "", deploymentUrl = "" }) {
  const targets = [];
  if (deploymentUrl) {
    targets.push({
      label: "web deployment",
      url: `${deploymentUrl.replace(/\/+$/, "")}/api/healthz`,
      useVercelCli: true,
    });
  }
  if (webUrl) {
    const url = `${webUrl.replace(/\/+$/, "")}/api/healthz`;
    if (!targets.some((target) => target.url === url)) {
      targets.push({ label: "web production domain", url, useVercelCli: false });
    }
  }
  return targets;
}
