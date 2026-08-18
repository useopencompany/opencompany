import assert from "node:assert/strict";
import test from "node:test";

import {
  missingProductionKeys,
  productionEnvironmentEntries,
  validateProject,
} from "./release-vercel.mjs";

test("validates the web project root and skew protection", () => {
  assert.doesNotThrow(() =>
    validateProject(
      "web",
      { id: "web", rootDirectory: "apps/web", skewProtectionMaxAge: 604800 },
      { projectId: "web" },
    ),
  );
  assert.throws(
    () =>
      validateProject(
        "web",
        { id: "web", rootDirectory: "apps/web", skewProtectionMaxAge: 1 },
        { projectId: "web" },
      ),
    /Skew Protection/,
  );
});

test("requires marketing to use its own correctly rooted project", () => {
  assert.throws(
    () =>
      validateProject(
        "marketing",
        { id: "same", rootDirectory: "apps/marketing" },
        { projectId: "same", webProjectId: "same" },
      ),
    /separate Vercel project/,
  );
});

test("checks only unscoped production environment entries", () => {
  const envs = productionEnvironmentEntries([
    { key: "A", target: ["production"] },
    { key: "B", target: ["production"], gitBranch: "main" },
    { key: "C", target: ["preview"] },
  ]);
  assert.deepEqual(
    envs.map((entry) => entry.key),
    ["A"],
  );
  assert.deepEqual(
    missingProductionKeys("marketing", [
      { key: "NEXT_PUBLIC_OPENCOMPANY_POSTHOG_TOKEN", target: ["production"] },
    ]),
    ["NEXT_PUBLIC_OPENCOMPANY_POSTHOG_HOST"],
  );
});
