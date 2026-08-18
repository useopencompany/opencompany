import assert from "node:assert/strict";
import test from "node:test";

import {
  deploymentFinalState,
  renderSurfaceResults,
  unsuccessfulSelectedSurfaces,
  webDependenciesPassed,
} from "./release-orchestration.mjs";

test("preserves API success when the runner fails", () => {
  const results = renderSurfaceResults(["api", "runner"], {
    api: { status: "fulfilled" },
    runner: { status: "rejected" },
  });
  assert.deepEqual(results, { api: "success", runner: "failure" });
  assert.equal(webDependenciesPassed({ api: true, runner: true }, results), false);
});

test("allows web when selected backend dependencies passed", () => {
  assert.equal(
    webDependenciesPassed({ api: true, runner: false }, { api: "success", runner: "skipped" }),
    true,
  );
});

test("marks blocked deployments inactive instead of failed", () => {
  assert.equal(
    deploymentFinalState({ selected: true, attempted: false, succeeded: false }),
    "inactive",
  );
  assert.equal(
    deploymentFinalState({ selected: true, attempted: true, succeeded: false }),
    "failure",
  );
});

test("reports only selected surfaces without a deployment record or success", () => {
  assert.deepEqual(
    unsuccessfulSelectedSurfaces({
      database: { selected: true, deploymentId: "1", result: "success" },
      api: { selected: true, deploymentId: "2", result: "success" },
      runner: { selected: true, deploymentId: "3", result: "failure" },
      web: { selected: true, deploymentId: "", result: "skipped" },
      marketing: { selected: false, deploymentId: "", result: "skipped" },
    }),
    ["runner", "web"],
  );
});
