import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MOBILE_BUILD_ENV_KEYS,
  validateMobileBuildArchive,
} from "../check-mobile-build-archive.mjs";

const ciEnvironment = {
  APP_VARIANT: "production",
  EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN: "https://api.example.com/",
  EXPO_PUBLIC_POSTHOG_API_KEY: "phc_public_project_token",
  EXPO_PUBLIC_WORKOS_CLIENT_ID: "client_production",
};

test("accepts an archive with the exact production mobile environment", () => {
  withArchive((archiveDirectory) => {
    writeMobileEnv(archiveDirectory, ciEnvironment);
    assert.equal(validateMobileBuildArchive(archiveDirectory, ciEnvironment), true);
  });
});

test("fails when the archived mobile environment is missing, even if CI has its values", () => {
  withArchive((archiveDirectory) => {
    assert.throws(
      () => validateMobileBuildArchive(archiveDirectory, ciEnvironment),
      (error) =>
        error.message.includes("apps/mobile/.env") &&
        !error.message.includes(ciEnvironment.EXPO_PUBLIC_WORKOS_CLIENT_ID),
    );
  });
});

for (const key of MOBILE_BUILD_ENV_KEYS) {
  test(`fails when ${key} is missing from the archived environment`, () => {
    withArchive((archiveDirectory) => {
      const values = { ...ciEnvironment };
      delete values[key];
      writeMobileEnv(archiveDirectory, values);
      assert.throws(
        () => validateMobileBuildArchive(archiveDirectory, ciEnvironment),
        new RegExp(key),
      );
    });
  });

  test(`fails when ${key} is blank in the archived environment`, () => {
    withArchive((archiveDirectory) => {
      writeMobileEnv(archiveDirectory, { ...ciEnvironment, [key]: "" });
      assert.throws(
        () => validateMobileBuildArchive(archiveDirectory, ciEnvironment),
        new RegExp(key),
      );
    });
  });
}

test("fails for a non-production app variant", () => {
  withArchive((archiveDirectory) => {
    writeMobileEnv(archiveDirectory, { ...ciEnvironment, APP_VARIANT: "development" });
    assert.throws(
      () => validateMobileBuildArchive(archiveDirectory, ciEnvironment),
      /APP_VARIANT.*production/u,
    );
  });
});

test("fails for an API value that violates the app URL restrictions", () => {
  const credentialedApiOrigin = new URL("https://api.example.com/");
  credentialedApiOrigin.username = "fixture-user";
  credentialedApiOrigin.password = "fixture-password";

  for (const apiOrigin of [
    "api.example.com",
    "ftp://api.example.com/",
    credentialedApiOrigin.href,
    "https://api.example.com/v1",
    "https://api.example.com/?debug=1",
    "https://api.example.com/#fragment",
  ]) {
    withArchive((archiveDirectory) => {
      writeMobileEnv(archiveDirectory, {
        ...ciEnvironment,
        EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN: apiOrigin,
      });
      assert.throws(
        () =>
          validateMobileBuildArchive(archiveDirectory, {
            ...ciEnvironment,
            EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN: apiOrigin,
          }),
        /EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN/u,
      );
    });
  }
});

test("fails when the archived environment contains an unexpected key", () => {
  withArchive((archiveDirectory) => {
    writeMobileEnv(archiveDirectory, { ...ciEnvironment, EXPO_TOKEN: "unexpected" });
    assert.throws(
      () => validateMobileBuildArchive(archiveDirectory, ciEnvironment),
      /unexpected EXPO_TOKEN/u,
    );
  });
});

test("fails when an archived value does not match the CI value without exposing either value", () => {
  const archivedClientId = "client_archived_only";
  withArchive((archiveDirectory) => {
    writeMobileEnv(archiveDirectory, {
      ...ciEnvironment,
      EXPO_PUBLIC_WORKOS_CLIENT_ID: archivedClientId,
    });
    assert.throws(
      () => validateMobileBuildArchive(archiveDirectory, ciEnvironment),
      (error) =>
        error.message.includes("EXPO_PUBLIC_WORKOS_CLIENT_ID") &&
        !error.message.includes(archivedClientId) &&
        !error.message.includes(ciEnvironment.EXPO_PUBLIC_WORKOS_CLIENT_ID),
    );
  });
});

function withArchive(callback) {
  const archiveDirectory = mkdtempSync(path.join(tmpdir(), "opencompany-mobile-archive-"));
  try {
    callback(archiveDirectory);
  } finally {
    rmSync(archiveDirectory, { recursive: true, force: true });
  }
}

function writeMobileEnv(archiveDirectory, values) {
  const mobileDirectory = path.join(archiveDirectory, "apps", "mobile");
  mkdirSync(mobileDirectory, { recursive: true });
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(path.join(mobileDirectory, ".env"), `${lines.join("\n")}\n`);
}
