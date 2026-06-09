import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildElectricServiceSpec,
  buildRunnerServiceSpec,
  buildStreamsServiceSpec,
  serviceHasPreviewTag,
  toRenderEnvVars,
} from "./preview-render.mjs";

test("toRenderEnvVars converts a flat env object and stringifies values", () => {
  assert.deepEqual(toRenderEnvVars({ A: "1", B: 2 }), [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
  ]);
  assert.deepEqual(toRenderEnvVars(), []);
});

test("runner spec builds Dockerfile.runner from repo+branch, autoDeploy off, tagged", () => {
  const spec = buildRunnerServiceSpec({
    name: "oc-preview-pr-42-runner",
    ownerId: "tea-1",
    repo: "https://github.com/useopencompany/opencompany-experimental",
    branch: "feature/x",
    env: { PREVIEW_ENV: "true" },
  });
  assert.equal(spec.type, "web_service");
  assert.equal(spec.autoDeploy, "no");
  assert.equal(spec.branch, "feature/x");
  assert.equal(spec.serviceDetails.healthCheckPath, "/healthz");
  assert.equal(spec.serviceDetails.envSpecificDetails.dockerfilePath, "./Dockerfile.runner");
  assert.ok(serviceHasPreviewTag(spec));
  assert.deepEqual(spec.envVars, [{ key: "PREVIEW_ENV", value: "true" }]);
});

test("electric spec runs the public image with /v1/health and is tagged", () => {
  const spec = buildElectricServiceSpec({
    name: "oc-preview-pr-42-electric",
    ownerId: "tea-1",
    env: { ELECTRIC_SECRET: "sek" },
  });
  assert.equal(spec.image.imagePath, "docker.io/electricsql/electric:latest");
  assert.equal(spec.serviceDetails.env, "image");
  assert.equal(spec.serviceDetails.healthCheckPath, "/v1/health");
  assert.ok(serviceHasPreviewTag(spec));
});

test("streams spec runs the reference server with caller-provided env", () => {
  const spec = buildStreamsServiceSpec({
    name: "oc-preview-pr-42-streams",
    ownerId: "tea-1",
    repo: "https://github.com/useopencompany/opencompany-experimental",
    branch: "feature/x",
    env: { DURABLE_STREAMS_DEV_HOST: "0.0.0.0" },
  });
  assert.equal(
    spec.serviceDetails.envSpecificDetails.startCommand,
    "bun scripts/durable-streams-dev.mjs",
  );
  assert.deepEqual(
    spec.envVars.find((v) => v.key === "DURABLE_STREAMS_DEV_HOST"),
    { key: "DURABLE_STREAMS_DEV_HOST", value: "0.0.0.0" },
  );
  assert.ok(serviceHasPreviewTag(spec));
});

test("serviceHasPreviewTag reads both tag locations and rejects prod services", () => {
  assert.equal(serviceHasPreviewTag({ tags: ["opencompany-preview"] }), true);
  assert.equal(serviceHasPreviewTag({ serviceDetails: { tags: ["opencompany-preview"] } }), true);
  assert.equal(serviceHasPreviewTag({ name: "opencompany-runner", tags: ["prod"] }), false);
  assert.equal(serviceHasPreviewTag({}), false);
});
