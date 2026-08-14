// Called by: scripts/dev.mjs in web app mode.
// Purpose: isolate each Conductor workspace's local services without changing
// the conventional fixed ports used outside Conductor.

import { findPortListeners, normalizePort } from "./port-kill.mjs";

const DEFAULT_WEB_PORT = "3002";
const DEFAULT_RUNNER_PORT = "3040";
const DEFAULT_WEB_HTTPS_PORT = "3443";

export function resolveWebDevPorts({ env = process.env } = {}) {
  const conductorBase = optionalPort(env.CONDUCTOR_PORT, "CONDUCTOR_PORT");
  if (conductorBase) {
    return {
      app: conductorBase,
      runner: offsetPort(conductorBase, 1, "runner"),
      https: offsetPort(conductorBase, 2, "web HTTPS"),
      electric: offsetPort(conductorBase, 3, "Electric"),
      isolated: true,
    };
  }

  return resolveConventionalWebDevPorts({ env });
}

export function selectWebDevPorts({
  env = process.env,
  httpsDisabled = false,
  portIsAvailable = (port) => findPortListeners(port).length === 0,
} = {}) {
  const allocated = resolveWebDevPorts({ env });
  if (!allocated.isolated) return allocated;

  const conventional = resolveConventionalWebDevPorts({ env });
  const requiredPorts = [conventional.app, conventional.runner];
  if (!httpsDisabled) requiredPorts.push(conventional.https);

  return requiredPorts.every((port) => portIsAvailable(port)) ? conventional : allocated;
}

function resolveConventionalWebDevPorts({ env }) {
  return {
    app: optionalPort(env.OPENCOMPANY_PORT, "OPENCOMPANY_PORT") ?? DEFAULT_WEB_PORT,
    runner: configuredRunnerPort(env) ?? DEFAULT_RUNNER_PORT,
    https:
      optionalPort(env.OPENCOMPANY_HTTPS_PORT, "OPENCOMPANY_HTTPS_PORT") ?? DEFAULT_WEB_HTTPS_PORT,
    isolated: false,
  };
}

export function isolatedWebDevEnvironment(ports, { httpsDisabled = false } = {}) {
  if (!ports.isolated) return {};

  const httpOrigin = `http://localhost:${ports.app}`;
  const appOrigin = httpsDisabled ? httpOrigin : `https://localhost:${ports.https}`;
  const runnerOrigin = `http://localhost:${ports.runner}`;

  return {
    OPENCOMPANY_PORT: ports.app,
    OPENCOMPANY_HTTPS_PORT: ports.https,
    OPENCOMPANY_NEXT_PUBLIC_APP_URL: appOrigin,
    OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${appOrigin}/auth/callback`,
    PORT: ports.runner,
    RUNNER_INTERNAL_URL: runnerOrigin,
    RUNNER_PUBLIC_URL: runnerOrigin,
    ELECTRIC_URL: `http://localhost:${ports.electric}`,
  };
}

function configuredRunnerPort(env) {
  const configured = env.RUNNER_INTERNAL_URL?.trim() || env.RUNNER_PUBLIC_URL?.trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (url.port) return normalizePort(url.port);
    return url.protocol === "https:" ? "443" : "80";
  } catch {
    return null;
  }
}

function optionalPort(value, label) {
  const configured = value?.trim();
  if (!configured) return null;
  try {
    return normalizePort(configured);
  } catch {
    throw new Error(`${label} must be a TCP port from 1 to 65535; received ${configured}.`);
  }
}

function offsetPort(base, offset, label) {
  const port = Number(base) + offset;
  if (port > 65_535) {
    throw new Error(
      `CONDUCTOR_PORT ${base} leaves no available ${label} port at offset +${offset}.`,
    );
  }
  return String(port);
}
