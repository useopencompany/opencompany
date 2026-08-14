import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isolatedWebDevEnvironment,
  resolveWebDevPorts,
  selectWebDevPorts,
} from "./web-dev-ports.mjs";

test("web dev keeps conventional ports outside Conductor", () => {
  assert.deepEqual(resolveWebDevPorts({ env: {} }), {
    app: "3002",
    runner: "3040",
    https: "3443",
    isolated: false,
  });
});

test("web dev respects explicitly configured fixed ports outside Conductor", () => {
  assert.deepEqual(
    resolveWebDevPorts({
      env: {
        OPENCOMPANY_PORT: "3102",
        OPENCOMPANY_HTTPS_PORT: "3543",
        RUNNER_INTERNAL_URL: "http://localhost:3140",
      },
    }),
    {
      app: "3102",
      runner: "3140",
      https: "3543",
      isolated: false,
    },
  );
});

test("Conductor allocation provides isolated ports for every web-stack service", () => {
  const ports = resolveWebDevPorts({
    env: {
      CONDUCTOR_PORT: "55010",
      OPENCOMPANY_PORT: "3002",
      OPENCOMPANY_HTTPS_PORT: "3443",
      RUNNER_INTERNAL_URL: "http://localhost:3040",
    },
  });

  assert.deepEqual(ports, {
    app: "55010",
    runner: "55011",
    https: "55012",
    electric: "55013",
    isolated: true,
  });
  assert.deepEqual(isolatedWebDevEnvironment(ports), {
    OPENCOMPANY_PORT: "55010",
    OPENCOMPANY_HTTPS_PORT: "55012",
    OPENCOMPANY_NEXT_PUBLIC_APP_URL: "https://localhost:55012",
    OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://localhost:55012/auth/callback",
    PORT: "55011",
    RUNNER_INTERNAL_URL: "http://localhost:55011",
    RUNNER_PUBLIC_URL: "http://localhost:55011",
    ELECTRIC_URL: "http://localhost:55013",
  });
});

test("Conductor keeps conventional ports when they are available", () => {
  const ports = selectWebDevPorts({
    env: {
      CONDUCTOR_PORT: "55010",
      OPENCOMPANY_PORT: "3002",
      OPENCOMPANY_HTTPS_PORT: "3443",
      RUNNER_INTERNAL_URL: "http://localhost:3040",
    },
    portIsAvailable: () => true,
  });

  assert.deepEqual(ports, {
    app: "3002",
    runner: "3040",
    https: "3443",
    isolated: false,
  });
});

test("Conductor falls back to its isolated range when a conventional port is busy", () => {
  const ports = selectWebDevPorts({
    env: { CONDUCTOR_PORT: "55010" },
    portIsAvailable: (port) => port !== "3002",
  });

  assert.deepEqual(ports, {
    app: "55010",
    runner: "55011",
    https: "55012",
    electric: "55013",
    isolated: true,
  });
});

test("disabled local HTTPS does not force an isolated range when only 3443 is busy", () => {
  const ports = selectWebDevPorts({
    env: { CONDUCTOR_PORT: "55010" },
    httpsDisabled: true,
    portIsAvailable: (port) => port !== "3443",
  });

  assert.equal(ports.isolated, false);
  assert.equal(ports.app, "3002");
});

test("Conductor allocation uses the HTTP web origin when local HTTPS is disabled", () => {
  const ports = resolveWebDevPorts({ env: { CONDUCTOR_PORT: "55010" } });

  assert.equal(
    isolatedWebDevEnvironment(ports, { httpsDisabled: true }).OPENCOMPANY_NEXT_PUBLIC_APP_URL,
    "http://localhost:55010",
  );
});

test("Conductor allocation rejects a base port without room for companion services", () => {
  assert.throws(
    () => resolveWebDevPorts({ env: { CONDUCTOR_PORT: "65535" } }),
    /leaves no available runner port/,
  );
});
