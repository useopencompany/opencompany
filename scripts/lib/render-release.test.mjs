import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRenderServiceShutdownDelay,
  deployCommitMatches,
  isFailedDeployStatus,
  selectNewDeployForRelease,
} from "./render-release.mjs";

const releaseSha = "5c280099d2d5bd805a1a5c8cf82474033ad28406";

test("selects the newly triggered deploy instead of a same-SHA Blueprint deploy", () => {
  const blueprintDeploy = {
    id: "dep_blueprint",
    status: "deactivated",
    trigger: "blueprint_sync",
    commit: { id: releaseSha },
  };
  const apiDeploy = {
    id: "dep_api",
    status: "queued",
    trigger: "api",
    commit: { id: releaseSha },
  };

  assert.equal(
    selectNewDeployForRelease([blueprintDeploy, apiDeploy], releaseSha, new Set()),
    apiDeploy,
  );
});

test("waits until Render exposes a deploy that was not present before the trigger", () => {
  const existingDeploy = {
    id: "dep_existing",
    status: "live",
    trigger: "api",
    commit: { id: releaseSha },
  };

  assert.equal(
    selectNewDeployForRelease([existingDeploy], releaseSha, new Set([existingDeploy.id])),
    null,
  );
});

test("accepts Render's abbreviated commit identifiers", () => {
  assert.equal(deployCommitMatches({ commit: { id: releaseSha.slice(0, 12) } }, releaseSha), true);
});

test("treats a superseded deploy as terminal", () => {
  assert.equal(isFailedDeployStatus("deactivated"), true);
  assert.equal(isFailedDeployStatus("update_in_progress"), false);
});

test("rejects a Render service whose live shutdown delay drifted", () => {
  const service = {
    name: "opencompany-runner-frankfurt",
    serviceDetails: { maxShutdownDelaySeconds: 120 },
  };

  assert.throws(
    () => assertRenderServiceShutdownDelay(service, 300),
    /maxShutdownDelaySeconds=120, expected 300/u,
  );
  assert.doesNotThrow(() =>
    assertRenderServiceShutdownDelay(
      { ...service, serviceDetails: { maxShutdownDelaySeconds: 300 } },
      300,
    ),
  );
});
