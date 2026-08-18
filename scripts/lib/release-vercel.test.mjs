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
test("scopes Vercel smoke requests to the deployment team", () => {
  assert.deepEqual(
    vercelCurlArgs("/api/healthz", "https://web.example.vercel.app", {
      token: " token ",
      teamId: " team ",
    }),
    [
      "vercel",
      "curl",
      "/api/healthz",
      "--deployment",
      "https://web.example.vercel.app",
      "--token",
      "token",
      "--scope",
      "team",
    ],
  );
});
