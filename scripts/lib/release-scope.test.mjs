import assert from "node:assert/strict";
import test from "node:test";

import { planReleaseSurfaces } from "./release-scope.mjs";

test("maps Turbo affected packages to production surfaces", () => {
  assert.deepEqual(
    planReleaseSurfaces({
      affectedPackages: ["@opencompany/analytics", "@opencompany/web", "@opencompany/runner"],
    }),
    { web: true, marketing: false, runner: true },
  );
});

test("manual releases deploy every requested surface", () => {
  assert.deepEqual(planReleaseSurfaces({ deployAll: true, deployRunner: false }), {
    web: true,
    marketing: true,
    runner: false,
  });
});

test("release workflow changes conservatively deploy every surface", () => {
  assert.deepEqual(
    planReleaseSurfaces({ changedFiles: [".github/workflows/release-production.yml"] }),
    { web: true, marketing: true, runner: true },
  );
});

test("Vercel orchestration changes deploy only Vercel surfaces", () => {
  assert.deepEqual(planReleaseSurfaces({ changedFiles: ["scripts/release-vercel-deploy.mjs"] }), {
    web: true,
    marketing: true,
    runner: false,
  });
});

test("runner image changes deploy only the runner", () => {
  assert.deepEqual(planReleaseSurfaces({ changedFiles: ["Dockerfile.runner"] }), {
    web: false,
    marketing: false,
    runner: true,
  });
});

test("unrelated documentation changes do not deploy an application", () => {
  assert.deepEqual(planReleaseSurfaces({ changedFiles: ["docs/getting-started.md"] }), {
    web: false,
    marketing: false,
    runner: false,
  });
});
