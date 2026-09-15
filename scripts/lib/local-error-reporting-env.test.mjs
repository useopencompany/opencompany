import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  errorReportingEnvRemovalPlan,
  intentionalErrorReportingEnv,
  removeGeneratedErrorReportingEnv,
  restoreIntentionalErrorReportingEnv,
} from "./local-error-reporting-env.mjs";

test("removes generated error DSNs from an existing checkout and keeps personal overrides active", () => {
  withTempCheckout(({ rootEnv, personalEnv, webEnv }) => {
    writeFileSync(
      rootEnv,
      [
        "WORKOS_CLIENT_ID=client_1",
        "BETTER_STACK_ERRORS_DSN=https://generated-server.example/1",
        "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN=https://generated-browser.example/1",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(
      webEnv,
      [
        "NEXT_PUBLIC_APP_URL=http://localhost:3002",
        "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN=https://generated-browser.example/1",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(
      personalEnv,
      [
        "BETTER_STACK_ERRORS_DSN=https://personal-server.example/2",
        "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN=https://personal-browser.example/2",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const intentionalEnv = intentionalErrorReportingEnv({
      inheritedEnv: {},
      personalEnvPath: personalEnv,
    });
    assert.deepEqual(errorReportingEnvRemovalPlan([rootEnv, webEnv]), [
      { path: rootEnv, key: "BETTER_STACK_ERRORS_DSN" },
      { path: rootEnv, key: "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN" },
      { path: webEnv, key: "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN" },
    ]);

    removeGeneratedErrorReportingEnv([rootEnv, webEnv]);
    const processEnv = {
      BETTER_STACK_ERRORS_DSN: "https://generated-server.example/1",
      NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN: "https://generated-browser.example/1",
    };
    restoreIntentionalErrorReportingEnv(processEnv, intentionalEnv);

    assert.equal(readFileSync(rootEnv, "utf8"), "WORKOS_CLIENT_ID=client_1\n");
    assert.equal(readFileSync(webEnv, "utf8"), "NEXT_PUBLIC_APP_URL=http://localhost:3002\n");
    assert.match(readFileSync(personalEnv, "utf8"), /personal-server/u);
    assert.deepEqual(processEnv, {
      BETTER_STACK_ERRORS_DSN: "https://personal-server.example/2",
      NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN: "https://personal-browser.example/2",
    });
    assert.equal(statSync(rootEnv).mode & 0o777, 0o600);
    assert.equal(statSync(webEnv).mode & 0o777, 0o600);
    assert.deepEqual(removeGeneratedErrorReportingEnv([rootEnv, webEnv]), []);
  });
});

test("removes generated DSNs from the loaded process when there is no intentional override", () => {
  const processEnv = {
    BETTER_STACK_ERRORS_DSN: "https://generated-server.example/1",
    NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN: "https://generated-browser.example/1",
    KEEP: "yes",
  };

  restoreIntentionalErrorReportingEnv(processEnv, {});

  assert.deepEqual(processEnv, { KEEP: "yes" });
});

function withTempCheckout(callback) {
  const directory = mkdtempSync(join(tmpdir(), "opencompany-error-reporting-env-"));
  const webDirectory = join(directory, "apps", "web");
  mkdirSync(webDirectory, { recursive: true });
  try {
    callback({
      rootEnv: join(directory, ".env.local"),
      personalEnv: join(directory, ".env.override.local"),
      webEnv: join(webDirectory, ".env.local"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
