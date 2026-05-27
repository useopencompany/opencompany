#!/usr/bin/env node

// Called by: root `bun run infisical:export`.
// Purpose: exports selected Infisical paths into a local dotenv file while preserving local-only keys.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const env = readFlag("--env") ?? "dev";
const outputFile = readFlag("--output-file") ?? ".env.local";
const paths = readListFlag("--path");
if (paths.length === 0) {
  paths.push("/web", "/runner");
}

const preserveLocalKeys = new Set([
  "DATABASE_URL",
  "NEON_BRANCH",
  "INNGEST_DEV",
  "OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS",
]);
const localDefaultLines = ['OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS="louis@acta.so"'];
const chunks = [];
for (const path of paths) {
  const result = spawnSync(
    "infisical",
    ["export", "--env", env, "--path", path, "--format", "dotenv"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const lines = result.stdout
    .split("\n")
    .filter((line) => {
      const match = line.match(/^([A-Z0-9_]+)=/);
      return !match || !preserveLocalKeys.has(match[1]);
    })
    .join("\n")
    .trim();

  chunks.push(`# Infisical ${env} ${path}\n${lines}\n`);
}

const existingLocalOnly = readExistingLocalOnly(outputFile);
const localOnlyChunk =
  existingLocalOnly.length > 0
    ? `# Preserved local-only values\n${existingLocalOnly.join("\n")}\n\n`
    : "";

writeFileSync(outputFile, `${localOnlyChunk}${chunks.join("\n")}\n`);
console.log(
  `Exported Infisical ${env} secrets from ${paths.join(", ")} to ${outputFile}. ` +
    `Preserved local-only keys: ${Array.from(preserveLocalKeys).join(", ")}.`,
);

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function readListFlag(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function readExistingLocalOnly(path) {
  try {
    const existing = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => {
        const match = line.match(/^([A-Z0-9_]+)=/);
        return match && preserveLocalKeys.has(match[1]);
      });
    return appendMissingLocalDefaults(existing);
  } catch {
    return appendMissingLocalDefaults([]);
  }
}

function appendMissingLocalDefaults(lines) {
  const seen = new Set(
    lines.map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1]).filter((key) => key !== undefined),
  );

  return [...lines, ...localDefaultLines.filter((line) => !seen.has(line.split("=")[0]))];
}
