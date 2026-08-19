import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerRunArgs, resolveElectricDevConfig } from "./electric-dev.mjs";

test("Electric keeps its conventional identity outside Conductor", () => {
  assert.deepEqual(resolveElectricDevConfig({}), {
    container: "opencompany-electric",
    port: "3010",
  });
});

test("Electric is isolated for each Conductor workspace", () => {
  assert.deepEqual(resolveElectricDevConfig({ CONDUCTOR_PORT: "55010" }), {
    container: "opencompany-electric-55010",
    port: "55013",
  });
});

test("explicit Electric overrides take precedence", () => {
  assert.deepEqual(
    resolveElectricDevConfig({
      CONDUCTOR_PORT: "55010",
      ELECTRIC_CONTAINER_NAME: "custom-electric",
      ELECTRIC_DEV_PORT: "4010",
    }),
    { container: "custom-electric", port: "4010" },
  );
});

test("Electric rejects a Conductor range that exceeds the TCP port limit", () => {
  assert.throws(
    () => resolveElectricDevConfig({ CONDUCTOR_PORT: "65533" }),
    /no available Electric port/,
  );
});

test("Electric containers carry the cleanup ownership label", () => {
  const args = dockerRunArgs("postgresql://database", { env: {} });
  const labelIndex = args.indexOf("--label");

  assert.notEqual(labelIndex, -1);
  assert.equal(args[labelIndex + 1], "dev.opencompany.service=electric");
});
