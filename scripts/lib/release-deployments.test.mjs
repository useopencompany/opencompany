import assert from "node:assert/strict";
import test from "node:test";

import { deploymentEnvironment, latestSuccessfulDeploymentSha } from "./release-deployments.mjs";

test("uses a distinct GitHub deployment environment for each surface", () => {
  assert.equal(deploymentEnvironment("database"), "production-database");
  assert.equal(deploymentEnvironment("runner"), "production-runner");
  assert.throws(() => deploymentEnvironment("unknown"), /Unknown production surface/);
});

test("selects only a deployment whose latest status is successful", () => {
  const failedSha = "a".repeat(40);
  const successfulSha = "b".repeat(40);
  const deployments = [
    { id: 1, sha: failedSha },
    { id: 2, sha: successfulSha },
  ];
  const statuses = new Map([
    [1, [{ state: "failure" }, { state: "success" }]],
    [2, [{ state: "success" }]],
  ]);

  assert.equal(latestSuccessfulDeploymentSha(deployments, statuses), successfulSha);
});

test("keeps a successful current-SHA surface out of a partial retry", () => {
  const currentSha = "c".repeat(40);
  const deployments = [{ id: 3, sha: currentSha }];
  const statuses = new Map([[3, [{ state: "success" }]]]);

  assert.equal(latestSuccessfulDeploymentSha(deployments, statuses), currentSha);
});
