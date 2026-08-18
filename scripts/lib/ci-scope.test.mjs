import assert from "node:assert/strict";
import test from "node:test";

import { requiresFullCi, resolveCiScope } from "./ci-scope.mjs";

const base = "a".repeat(40);
const head = "b".repeat(40);

function resolve(overrides = {}) {
  return resolveCiScope({
    requestedScope: "affected",
    baseSha: base,
    headSha: head,
    baseExists: true,
    headExists: true,
    baseIsAncestor: true,
    changedFiles: ["apps/web/app/page.tsx"],
    ...overrides,
  });
}

test("uses Turbo affected mode for an ordinary valid range", () => {
  assert.deepEqual(resolve(), {
    scope: "affected",
    reason: "the Git comparison is safe for Turbo --affected",
  });
});

test("forces the full suite for explicit full requests and unsafe ranges", () => {
  assert.equal(resolve({ requestedScope: "full" }).scope, "full");
  assert.equal(resolve({ baseSha: "invalid" }).scope, "full");
  assert.equal(resolve({ baseExists: false }).scope, "full");
  assert.equal(resolve({ baseSha: head }).scope, "full");
  assert.equal(resolve({ baseIsAncestor: false }).scope, "full");
});

test("forces the full suite when workflow or task graph inputs change", () => {
  for (const file of [
    ".github/workflows/verify.yml",
    "package.json",
    "bun.lock",
    "turbo.json",
    "tsconfig.base.json",
    "biome.json",
    "apps/web/package.json",
    "packages/db/package.json",
    "scripts/ci-scope.mjs",
    "scripts/lib/ci-scope.test.mjs",
  ]) {
    assert.equal(requiresFullCi([file]), true, `${file} must force full CI`);
    assert.equal(resolve({ changedFiles: [file] }).scope, "full");
  }
});

test("does not force unrelated application and documentation changes", () => {
  assert.equal(requiresFullCi(["apps/web/app/page.tsx", "docs/deployment.md"]), false);
});
