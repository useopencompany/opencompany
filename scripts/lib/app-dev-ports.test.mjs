import assert from "node:assert/strict";
import { test } from "node:test";
import { isolatedDevEnvironment, resolveDevPorts, selectDevPorts } from "./app-dev-ports.mjs";

test("Goat dev keeps conventional ports outside Conductor", () => {
  assert.deepEqual(resolveDevPorts({ env: {} }), {
    app: "3002",
    runner: "3040",
    https: "3443",
    durableStreams: "4150",
    isolated: false,
  });
});

test("Goat dev respects explicitly configured fixed ports outside Conductor", () => {
  assert.deepEqual(
    resolveDevPorts({
      env: {
        APP_PORT: "3102",
        APP_HTTPS_PORT: "3543",
        RUNNER_INTERNAL_URL: "http://localhost:3140",
        DURABLE_STREAMS_DEV_PORT: "4250",
      },
    }),
    {
      app: "3102",
      runner: "3140",
      https: "3543",
      durableStreams: "4250",
      isolated: false,
    },
  );
});

test("Conductor allocation provides isolated ports for every Goat service", () => {
  const ports = resolveDevPorts({
    env: {
      CONDUCTOR_PORT: "55010",
      APP_PORT: "3002",
      APP_HTTPS_PORT: "3443",
      RUNNER_INTERNAL_URL: "http://localhost:3040",
      DURABLE_STREAMS_DEV_PORT: "4150",
    },
  });

  assert.deepEqual(ports, {
    app: "55010",
    runner: "55011",
    https: "55012",
    durableStreams: "55013",
    electric: "55014",
    isolated: true,
  });
  assert.deepEqual(isolatedDevEnvironment(ports), {
    APP_PORT: "55010",
    APP_HTTPS_PORT: "55012",
    NEXT_PUBLIC_APP_URL: "https://localhost:55012",
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://localhost:55012/auth/callback",
    PORT: "55011",
    RUNNER_INTERNAL_URL: "http://localhost:55011",
    RUNNER_PUBLIC_URL: "http://localhost:55011",
    DURABLE_STREAMS_DEV_PORT: "55013",
    ELECTRIC_URL: "http://localhost:55014",
  });
});

test("Conductor keeps conventional ports when they are available", () => {
  const ports = selectDevPorts({
    env: {
      CONDUCTOR_PORT: "55010",
      APP_PORT: "3002",
      APP_HTTPS_PORT: "3443",
      RUNNER_INTERNAL_URL: "http://localhost:3040",
      DURABLE_STREAMS_DEV_PORT: "4150",
    },
    portIsAvailable: () => true,
  });

  assert.deepEqual(ports, {
    app: "3002",
    runner: "3040",
    https: "3443",
    durableStreams: "4150",
    isolated: false,
  });
});

test("Conductor falls back to its isolated range when a conventional port is busy", () => {
  const ports = selectDevPorts({
    env: { CONDUCTOR_PORT: "55010" },
    portIsAvailable: (port) => port !== "3002",
  });

  assert.deepEqual(ports, {
    app: "55010",
    runner: "55011",
    https: "55012",
    durableStreams: "55013",
    electric: "55014",
    isolated: true,
  });
});

test("Conductor isolates Durable Streams when its conventional port is busy", () => {
  const ports = selectDevPorts({
    env: { CONDUCTOR_PORT: "55010" },
    portIsAvailable: (port) => port !== "4150",
  });

  assert.deepEqual(ports, {
    app: "55010",
    runner: "55011",
    https: "55012",
    durableStreams: "55013",
    electric: "55014",
    isolated: true,
  });
});

test("disabled local HTTPS does not force an isolated range when only 3443 is busy", () => {
  const ports = selectDevPorts({
    env: { CONDUCTOR_PORT: "55010" },
    httpsDisabled: true,
    portIsAvailable: (port) => port !== "3443",
  });

  assert.equal(ports.isolated, false);
  assert.equal(ports.app, "3002");
});

test("Conductor allocation uses the HTTP Goat origin when local HTTPS is disabled", () => {
  const ports = resolveDevPorts({ env: { CONDUCTOR_PORT: "55010" } });

  assert.equal(
    isolatedDevEnvironment(ports, { httpsDisabled: true }).NEXT_PUBLIC_APP_URL,
    "http://localhost:55010",
  );
});

test("Conductor allocation rejects a base port without room for companion services", () => {
  assert.throws(
    () => resolveDevPorts({ env: { CONDUCTOR_PORT: "65535" } }),
    /leaves no available runner port/,
  );
});
