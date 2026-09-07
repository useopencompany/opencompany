import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  missingProductionKeys,
  productionEnvironmentEntries,
  restorePreparedVercelDirectory,
  savePreparedVercelDirectory,
  surfaceConfig,
  validateProject,
  vercelCurlArgs,
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

test("configures docs as a separate Vercel project with no runtime env", () => {
  assert.deepEqual(surfaceConfig("docs"), {
    projectEnv: "DOCS_VERCEL_PROJECT_ID",
    rootDirectory: "apps/docs",
    requiredEnv: [],
    minimumSkewProtectionMaxAge: 0,
  });
  assert.doesNotThrow(() =>
    validateProject(
      "docs",
      { id: "docs", rootDirectory: "apps/docs" },
      {
        projectId: "docs",
        webProjectId: "web",
        marketingProjectId: "marketing",
        docsProjectId: "docs",
      },
    ),
  );
  assert.throws(
    () =>
      validateProject(
        "docs",
        { id: "web", rootDirectory: "apps/docs" },
        { projectId: "web", webProjectId: "web", docsProjectId: "web" },
      ),
    /separate Vercel project from web/u,
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

test("preserves relative function symlinks through prepare and restore", () => {
  const root = mkdtempSync(join(tmpdir(), "opencompany-vercel-copy-"));
  const source = join(root, "source");
  const prepared = join(root, "prepared");
  const restored = join(root, "restored");

  try {
    const functions = join(source, "output", "functions");
    mkdirSync(join(functions, "canonical.func"), { recursive: true });
    writeFileSync(join(functions, "canonical.func", "index.js"), "export default true;\n");
    symlinkSync("canonical.func", join(functions, "alias.func"));

    savePreparedVercelDirectory(prepared, source);
    rmSync(source, { recursive: true, force: true });
    restorePreparedVercelDirectory(prepared, restored);

    assert.equal(
      readlinkSync(join(prepared, "output", "functions", "alias.func")),
      "canonical.func",
    );
    assert.equal(
      readlinkSync(join(restored, "output", "functions", "alias.func")),
      "canonical.func",
    );
    assert.equal(
      readFileSync(join(restored, "output", "functions", "alias.func", "index.js"), "utf8"),
      "export default true;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("targets an immutable Vercel URL without forwarding global flags to curl", () => {
  assert.deepEqual(vercelCurlArgs("/api/healthz", "https://web.example.vercel.app"), [
    "vercel",
    "curl",
    "https://web.example.vercel.app/api/healthz",
    "--yes",
  ]);
});
