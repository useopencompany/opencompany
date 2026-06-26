#!/usr/bin/env node

// Called by: root `bun run infisical:export`.
// Purpose: exports selected Infisical paths into a local dotenv file while preserving local-only keys.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const env = readFlag("--env") ?? "dev";
const outputFile = readFlag("--output-file") ?? ".env.local";
const paths = readListFlag("--path");
if (paths.length === 0) {
  paths.push("/web", "/runner", "/connector");
}

const preserveLocalKeys = new Set([
  "DATABASE_URL",
  "NEON_BRANCH",
  "INNGEST_DEV",
  "OPENCOMPANY_LOCAL_ONBOARDING_BYPASS_EMAILS",
]);
const LOCAL_WORKOS_REDIRECT_URI = "http://localhost:3000/auth/callback";
const LOCAL_CONNECTOR_APP_URL = "http://localhost:3002";
const LOCAL_CONNECTOR_WORKOS_REDIRECT_URI = "http://localhost:3002/auth/callback";
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
    .map((line) => localizeDevLine(line, path))
    .filter((line) => {
      const match = line.match(/^([A-Z0-9_]+)=/);
      if (!match) return true;
      if (preserveLocalKeys.has(match[1])) return false;
      return shouldKeepLineForPath(match[1], path);
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

function shouldKeepLineForPath(key, path) {
  if (path === "/connector" && key === "NEXT_PUBLIC_WORKOS_REDIRECT_URI") return false;
  return true;
}

function localizeDevLine(line, path) {
  if (env !== "dev") return line;
  const match = line.match(/^(NEXT_PUBLIC_WORKOS_REDIRECT_URI|WORKOS_REDIRECT_URI)=/);
  if (match) return `${match[1]}=${JSON.stringify(LOCAL_WORKOS_REDIRECT_URI)}`;

  if (path === "/connector") {
    const connectorMatch = line.match(/^(CONNECTOR_APP_URL|CONNECTOR_WORKOS_REDIRECT_URI)=/);
    if (connectorMatch?.[1] === "CONNECTOR_APP_URL") {
      return `${connectorMatch[1]}=${JSON.stringify(LOCAL_CONNECTOR_APP_URL)}`;
    }
    if (connectorMatch?.[1] === "CONNECTOR_WORKOS_REDIRECT_URI") {
      return `${connectorMatch[1]}=${JSON.stringify(LOCAL_CONNECTOR_WORKOS_REDIRECT_URI)}`;
    }
  }

  return line;
}
