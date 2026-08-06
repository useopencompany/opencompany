import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD_SANDBOX_PARENT_BRANCH,
  resolveNeonBranchName,
  resolveNeonParentBranch,
  sanitizeNeonBranchName,
} from "./neon-branch-config.mjs";

test("local branch names retain the existing sanitized Git branch behavior", () => {
  assert.equal(
    resolveNeonBranchName({ gitBranch: "Louis/Cloud setup", sandboxId: undefined }),
    "louis-cloud-setup",
  );
});

test("E2B branch names include the sandbox id", () => {
  assert.equal(
    resolveNeonBranchName({ gitBranch: "main", sandboxId: "sandbox_123" }),
    "main-e2b-sandbox-123",
  );
});

test("E2B branch names preserve the unique suffix when the Git branch is long", () => {
  const name = resolveNeonBranchName({
    gitBranch: "feature/this-is-a-very-long-branch-name-that-would-otherwise-use-the-whole-limit",
    sandboxId: "sandbox-1234567890",
  });

  assert.ok(name.length <= 63);
  assert.match(name, /-e2b-sandbox-1234567890$/);
});

test("an explicit branch override still wins in E2B", () => {
  assert.equal(
    resolveNeonBranchName({
      gitBranch: "main",
      branchNameOverride: "explicit_branch",
      sandboxId: "sandbox-123",
    }),
    "explicit-branch",
  );
});

test("E2B always uses the schema-only cloud base while local setup keeps its parent", () => {
  assert.equal(
    resolveNeonParentBranch({ localParentBranch: "production", sandboxId: "sandbox-123" }),
    CLOUD_SANDBOX_PARENT_BRANCH,
  );
  assert.equal(
    resolveNeonParentBranch({ localParentBranch: "production", sandboxId: undefined }),
    "production",
  );
});

test("empty branch names are rejected", () => {
  assert.throws(() => sanitizeNeonBranchName("___"), /valid Neon branch name/);
});
