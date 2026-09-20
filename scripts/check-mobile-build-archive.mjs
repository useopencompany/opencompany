#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseDotenv } from "dotenv";

export const MOBILE_BUILD_ENV_KEYS = [
  "APP_VARIANT",
  "EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN",
  "EXPO_PUBLIC_POSTHOG_API_KEY",
  "EXPO_PUBLIC_WORKOS_CLIENT_ID",
];

const MOBILE_ENV_PATH = path.join("apps", "mobile", ".env");

export function validateMobileBuildArchive(archiveDirectory, ciEnvironment = process.env) {
  const archiveEnv = readArchiveEnvironment(archiveDirectory);
  const archiveKeys = Object.keys(archiveEnv).sort();
  const expectedKeys = [...MOBILE_BUILD_ENV_KEYS].sort();
  const missingKeys = expectedKeys.filter((key) => !archiveKeys.includes(key));
  const unexpectedKeys = archiveKeys.filter((key) => !expectedKeys.includes(key));

  if (missingKeys.length > 0 || unexpectedKeys.length > 0) {
    const details = [];
    if (missingKeys.length > 0) details.push(`missing ${missingKeys.join(", ")}`);
    if (unexpectedKeys.length > 0) details.push(`unexpected ${unexpectedKeys.join(", ")}`);
    throw new Error(
      `Archived ${MOBILE_ENV_PATH} must contain exactly the expected keys: ${details.join("; ")}.`,
    );
  }

  const blankKeys = MOBILE_BUILD_ENV_KEYS.filter((key) => archiveEnv[key].trim() === "");
  if (blankKeys.length > 0) {
    throw new Error(
      `Archived ${MOBILE_ENV_PATH} contains blank values for ${blankKeys.join(", ")}.`,
    );
  }

  if (archiveEnv.APP_VARIANT !== "production") {
    throw new Error("Archived apps/mobile/.env must set APP_VARIANT to production.");
  }

  if (!isAllowedApiOrigin(archiveEnv.EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN)) {
    throw new Error(
      "Archived apps/mobile/.env must set EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN to a valid http(s) origin.",
    );
  }

  const missingCiKeys = MOBILE_BUILD_ENV_KEYS.filter(
    (key) => typeof ciEnvironment[key] !== "string" || ciEnvironment[key].trim() === "",
  );
  if (missingCiKeys.length > 0) {
    throw new Error(`CI is missing values for ${missingCiKeys.join(", ")}.`);
  }

  const mismatchedKeys = MOBILE_BUILD_ENV_KEYS.filter(
    (key) => archiveEnv[key] !== ciEnvironment[key],
  );
  if (mismatchedKeys.length > 0) {
    throw new Error(
      `Archived ${MOBILE_ENV_PATH} does not match the CI values for ${mismatchedKeys.join(", ")}.`,
    );
  }

  return true;
}

export function isAllowedApiOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return false;

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }

  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  );
}

function readArchiveEnvironment(archiveDirectory) {
  if (typeof archiveDirectory !== "string" || archiveDirectory.trim() === "") {
    throw new Error("An extracted EAS archive directory is required.");
  }

  const envPath = path.join(path.resolve(archiveDirectory), MOBILE_ENV_PATH);
  try {
    return parseDotenv(readFileSync(envPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`The inspected archive is missing ${MOBILE_ENV_PATH}.`);
    }
    throw new Error(`Could not read ${MOBILE_ENV_PATH} from the inspected archive.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const archiveDirectory = process.argv[2];
  if (!archiveDirectory || process.argv.length !== 3) {
    console.error("Usage: node scripts/check-mobile-build-archive.mjs <archive-directory>");
    process.exitCode = 2;
  } else {
    try {
      validateMobileBuildArchive(archiveDirectory);
      console.log("Mobile EAS archive contains the expected production configuration.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown archive validation error.";
      console.error(`::error::Mobile EAS archive check failed: ${message}`);
      process.exitCode = 1;
    }
  }
}
