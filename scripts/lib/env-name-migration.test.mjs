import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  environmentFileMigrationPlan,
  migratedEnvironmentName,
  migrateEnvironmentFile,
} from "./env-name-migration.mjs";

test("maps supported legacy environment names to the hard-cut contract", () => {
  assert.equal(migratedEnvironmentName("GOAT_PORT"), "OPENCOMPANY_PORT");
  assert.equal(
    migratedEnvironmentName("NEXT_PUBLIC_GOAT_API_ORIGIN"),
    "NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN",
  );
  assert.equal(
    migratedEnvironmentName("RUNNER_GOAT_TASK_WORKER_ENABLED"),
    "RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED",
  );
  assert.equal(migratedEnvironmentName("PRODUCTION_GOAT_URL"), "PRODUCTION_OPENCOMPANY_URL");
  assert.equal(migratedEnvironmentName("SMOKE_GOAT"), "SMOKE_WEB");
  assert.equal(migratedEnvironmentName("EXPECTED_GOAT_RELEASE"), "EXPECTED_WEB_RELEASE");
  assert.equal(migratedEnvironmentName("DATABASE_URL"), null);
});

test("migrates an existing env file once and removes an equal duplicate", () => {
  withTempEnv(
    [
      "# local values",
      'GOAT_PORT="3002"',
      "NEXT_PUBLIC_GOAT_API_ORIGIN=https://api.example.test",
      "OPENCOMPANY_STRIPE_API_KEY=rk_test_same",
      'GOAT_STRIPE_API_KEY="rk_test_same"',
      "DATABASE_URL=postgresql://example",
      "",
    ].join("\n"),
    (path) => {
      const moves = migrateEnvironmentFile(path);
      assert.deepEqual(
        moves.map(({ oldName, newName }) => [oldName, newName]),
        [
          ["GOAT_PORT", "OPENCOMPANY_PORT"],
          ["NEXT_PUBLIC_GOAT_API_ORIGIN", "NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN"],
          ["GOAT_STRIPE_API_KEY", "OPENCOMPANY_STRIPE_API_KEY"],
        ],
      );
      assert.equal(
        readFileSync(path, "utf8"),
        [
          "# local values",
          'OPENCOMPANY_PORT="3002"',
          "NEXT_PUBLIC_OPENCOMPANY_API_ORIGIN=https://api.example.test",
          "OPENCOMPANY_STRIPE_API_KEY=rk_test_same",
          "DATABASE_URL=postgresql://example",
          "",
        ].join("\n"),
      );
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(migrateEnvironmentFile(path), []);
    },
  );
});

test("reports moved variable names when old and new values conflict", () => {
  withTempEnv("GOAT_PORT=3002\nOPENCOMPANY_PORT=4000\n", (path) => {
    const before = readFileSync(path, "utf8");
    assert.throws(() => environmentFileMigrationPlan(path), /GOAT_PORT → OPENCOMPANY_PORT/u);
    assert.equal(readFileSync(path, "utf8"), before);
  });
});

function withTempEnv(contents, callback) {
  const directory = mkdtempSync(join(tmpdir(), "opencompany-env-migration-"));
  const path = join(directory, ".env.local");
  try {
    writeFileSync(path, contents, { mode: 0o600 });
    callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
