import assert from "node:assert/strict";
import test from "node:test";

import { planReleaseSurfaces } from "./release-scope.mjs";

test("maps Turbo affected packages to production surfaces", () => {
  assert.deepEqual(
    planReleaseSurfaces({
      affectedPackages: [
        "@opencompany/analytics",
        "@opencompany/web",
        "@opencompany/api",
        "@opencompany/runner",
      ],
    }),
    { web: true, marketing: false, api: true, runner: true },
  );
});

test("manual releases deploy every requested surface", () => {
  assert.deepEqual(
    planReleaseSurfaces({ deployAll: true, deployApi: false, deployRunner: false }),
    {
      web: true,
      marketing: true,
      api: false,
      runner: false,
    },
  );
});

test("the transient presentation package deploys both Redis participants", () => {
  assert.deepEqual(planReleaseSurfaces({ affectedPackages: ["@opencompany/chat-presentation"] }), {
    web: false,
    marketing: false,
    api: true,
    runner: true,
  });
});

test("release workflow changes conservatively deploy every surface", () => {
  assert.deepEqual(
    planReleaseSurfaces({ changedFiles: [".github/workflows/release-production.yml"] }),
    { web: true, marketing: true, api: true, runner: true },
  );
});

test("Vercel orchestration changes deploy only Vercel surfaces", () => {
  assert.deepEqual(planReleaseSurfaces({ changedFiles: ["scripts/release-vercel-deploy.mjs"] }), {
    web: true,
    marketing: true,
    api: false,
    runner: false,
  });
});

test("API image changes deploy only the API", () => {
  assert.deepEqual(planReleaseSurfaces({ changedFiles: ["Dockerfile.api"] }), {
    web: false,
    marketing: false,
    api: true,
    runner: false,
  });
});

test("runner image changes deploy only the runner", () => {
  assert.deepEqual(planReleaseSurfaces({ changedFiles: ["Dockerfile.runner"] }), {
    web: false,
    marketing: false,
    api: false,
    runner: true,
  });
});

test("Render orchestration changes deploy both Render services", () => {
  assert.deepEqual(planReleaseSurfaces({ changedFiles: ["scripts/lib/render-release.mjs"] }), {
    web: false,
    marketing: false,
    api: true,
    runner: true,
  });
});

test("unrelated documentation changes do not deploy an application", () => {
  assert.deepEqual(planReleaseSurfaces({ changedFiles: ["docs/getting-started.md"] }), {
    web: false,
    marketing: false,
    api: false,
    runner: false,
  });
});
