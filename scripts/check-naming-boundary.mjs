import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { migratedEnvironmentName } from "./lib/env-name-migration.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historicalRoots = ["drizzle/", "docs/adr/"];
const expectedPackages = new Map([
  ["packages/agent/package.json", "@opencompany/agent"],
  ["packages/brain/package.json", "@opencompany/brain"],
  ["packages/telemetry/package.json", "@opencompany/telemetry"],
  ["packages/wiki/package.json", "@opencompany/wiki"],
]);
const legacyPackagePattern = /@opencompany\/goat-(?:agent|brain|observability|wiki)\b/u;
const legacyPathPattern = /(?:^|\/)goat-(?:agent|brain|observability|wiki)(?:\/|$)/u;
const uppercaseBrandPattern = /\bGoat\b|OpenCompany|Opencompany|openCompany/u;
const codeFacingGoatSymbolPattern =
  /\b(?:const|let|var|function|class|type|interface|enum)\s+[A-Z0-9_]*GOAT[A-Z0-9_]*|\bimport\s+.*\b[A-Z0-9_]*GOAT[A-Z0-9_]*/u;
const staleDocumentationNamePattern =
  /\bgoat-(?:agent|events|observability|wiki|brain(?:-(?!hubspot-public\b)[a-z0-9-]+)?)\b/u;
const compatibilityHeaders = ["X-OpenCompany-Protocol-Version", "X-OpenCompany-Run-Status"];
const allowedStandaloneFiles = new Set([
  "apps/api/src/stripe-ingress.ts",
  "packages/db/src/product-schema.ts",
  "scripts/lib/release-smoke.test.mjs",
]);
const protectedCompatibilityTokens = [
  [
    "physical and stored quoted goat_* identifiers",
    /["'`]goat_[a-z0-9_]*["'`]/gu,
    "[\"'`]goat_[a-z0-9_]*[\"'`]",
  ],
  [
    "quoted sandbox runtime roots",
    /["'`]opencompany-goat[a-z0-9_./${}:*-]*["'`]/gu,
    "[\"'`]opencompany-goat[a-z0-9_./${}:*-]*[\"'`]",
  ],
  ["chat source-provider values", /["']goat-chat["']/gu, '["\x27]goat-chat["\x27]'],
  ["import source-provider values", /["']goat-import["']/gu, '["\x27]goat-import["\x27]'],
];
const requiredCompatibilityFragments = new Map([
  ["packages/db/src/product-schema.ts", ['pgSchema("goat")', "'goat-chat', 'goat-import'"]],
  ["packages/agent/src/brain-capture.ts", ['"goat-chat"']],
  ["packages/agent/src/browser-profiles/index.ts", ['surface: "goat-browser-profile"']],
  ["packages/agent-runtime/src/cloud-coding-engines.ts", ["/home/user/opencompany-goat/"]],
  ["apps/runner/src/chat-artifacts.ts", ['"goat-chat-artifacts"']],
  ["apps/runner/src/codex-chat.ts", ["/home/user/.opencompany-goat/"]],
  ["apps/web/components/CodingWorkspacePanel.tsx", ['"goat-coding-workspace-panel-width-v1"']],
  ["apps/web/components/ThemeProvider.tsx", ['"opencompany-goat-theme"']],
  ["apps/web/lib/auth-methods.ts", ['"goat-last-auth-method"', '"goat-oauth-state"']],
  ["apps/web/lib/chat-composer-selection.ts", ['"opencompany-goat-main-chat-selection"']],
  ["apps/web/lib/onboarding-integrations.ts", ['"goat-onboarding-connection-result"']],
  ["apps/web/lib/onboarding-kickoff.ts", ['"goat-onboarding-kickoff-v1"']],
]);

const files = trackedAndUntrackedFiles();
const failures = [];
let currentCompatibilityCorpus = "";

for (const relativePath of files) {
  if (isHistorical(relativePath)) continue;
  if (relativePath === "scripts/check-naming-boundary.mjs") continue;
  if (legacyPathPattern.test(relativePath)) {
    failures.push(`${relativePath}: legacy code-facing path`);
  }

  let source;
  try {
    source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    if (error?.code === "EISDIR") continue;
    throw error;
  }
  currentCompatibilityCorpus += `\n${source}`;

  for (const [index, originalLine] of source.split("\n").entries()) {
    const lineNumber = index + 1;
    const line = compatibilityHeaders.reduce(
      (current, header) => current.replaceAll(header, ""),
      originalLine,
    );
    if (uppercaseBrandPattern.test(line)) {
      failures.push(`${relativePath}:${lineNumber}: uppercase written brand`);
    }
    if (legacyPackagePattern.test(line)) {
      failures.push(`${relativePath}:${lineNumber}: legacy package import`);
    }
    if (codeFacingGoatSymbolPattern.test(line)) {
      failures.push(
        `${relativePath}:${lineNumber}: legacy GOAT_* code symbol outside the env migration boundary`,
      );
    }
    const documentationLine = line.replaceAll("goat-brain-hubspot-public", "");
    if (/\.mdx?$/u.test(relativePath) && staleDocumentationNamePattern.test(documentationLine)) {
      failures.push(`${relativePath}:${lineNumber}: stale code-facing goat name in current docs`);
    }

    let remaining = line;
    remaining = remaining.replace(/\b[A-Z0-9_]*GOAT[A-Z0-9_]*\b/gu, "");
    remaining = remaining.replace(/\bopencompany\.goat_[a-z0-9_]+\b/gu, "");
    remaining = remaining.replace(/\bgoat(?:\\?\.)[a-z0-9_.*]+\b/gu, "");
    remaining = remaining.replace(/["'`]goat["'`]\s*\./gu, "");
    remaining = remaining.replace(/\bgoat_[a-z0-9_]*\b/gu, "");
    remaining = remaining.replace(/\bopencompany-(?:runner-)?goat(?:-[a-z0-9_./${}:*-]+)?/gu, "");
    remaining = remaining.replace(/\bgoat-[a-z0-9_./${}:*-]+/gu, "");
    remaining = remaining.replace(/\bgoat-(?=\[)/gu, "");
    remaining = remaining.replace(/\b(?:app|source):goat\b/gu, "");
    remaining = remaining.replace(/\/(?:internal\/)?goat(?:\/[a-z0-9_./${}:*%-]+)?/giu, "");
    remaining = remaining.replace(
      /\b(?:[a-z0-9*-]+\.)*goat\.(?:example|invalid|test)(?:\.com)?\b/giu,
      "",
    );
    remaining = remaining.replace(/\b(?:pgSchema|schema)\s*\(?["'`]goat["'`]?\)?/giu, "");
    remaining = remaining.replace(/\bCREATE\s+SCHEMA\s+goat\b/giu, "");
    remaining = remaining.replace(/["'`]goat\.["'`]/gu, "");
    if (/\bschema\b/iu.test(remaining)) remaining = remaining.replace(/\bgoat\b/giu, "");
    if (/\.not(?:\.|\()|not\.to/u.test(remaining))
      remaining = remaining.replace(/["'`]goat["'`]/gu, "");
    if (allowedStandaloneFiles.has(relativePath)) {
      remaining = remaining.replace(/["'`]goat["'`]/gu, "");
    }
    if (/\bgoat\b/iu.test(remaining)) {
      failures.push(`${relativePath}:${lineNumber}: unclassified goat occurrence`);
    }
  }
}

for (const [relativePath, fragments] of requiredCompatibilityFragments) {
  const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  for (const fragment of fragments) {
    if (!source.includes(fragment)) {
      failures.push(`${relativePath}: missing protected compatibility fragment ${fragment}`);
    }
  }
}

for (const [
  label,
  currentPattern,
  gitPattern,
  acceptedCutoverDelta = 0,
] of protectedCompatibilityTokens) {
  const currentCount = currentCompatibilityCorpus.match(currentPattern)?.length ?? 0;
  const expectedCount = gitMatchCount(gitPattern) + acceptedCutoverDelta;
  if (currentCount !== expectedCount) {
    failures.push(
      `${label}: expected ${expectedCount} retained occurrences, found ${currentCount}`,
    );
  }
}

for (const [manifestPath, packageName] of expectedPackages) {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, manifestPath), "utf8"));
  if (manifest.name !== packageName) {
    failures.push(`${manifestPath}: expected package name ${packageName}`);
  }
}

const immutableChanges = gitLines([
  "diff",
  "--name-status",
  "origin/main",
  "--",
  "drizzle",
  "docs/adr",
]);
const retiredUnjournaledMigrations = new Set(["drizzle/0102_goat_brain_folder_defaults.sql"]);
const relocatedUnjournaledMigration = [
  "drizzle/0102_goat_brain_folder_defaults.sql",
  "drizzle/0217_goat_brain_folder_defaults.sql",
];
for (const change of immutableChanges) {
  const [status, ...paths] = change.split("\t");
  const changedPath = paths.at(-1);
  if (status === "A" || (status === "M" && changedPath === "drizzle/meta/_journal.json")) {
    continue;
  }
  // This file never entered the journal, so it is not applied migration
  // history. Its idempotent contents now live in journaled migration 0217.
  if (status === "D" && retiredUnjournaledMigrations.has(changedPath)) continue;
  if (status.startsWith("R") && paths.join("\t") === relocatedUnjournaledMigration.join("\t")) {
    continue;
  }
  failures.push(`${changedPath}: immutable migration or ADR history changed`);
}

const currentEnvKeys = envKeys(await readFile(path.join(repositoryRoot, ".env.example"), "utf8"));
const baseEnvKeys = envKeys(
  execFileSync("git", ["show", "origin/main:.env.example"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }),
);
// Keys added after the GOAT→OPENCOMPANY hard cut. The boundary enforces that
// `.env.example` still matches origin/main modulo the rename map; genuinely new
// variables are declared here so the check accepts them.
const addedEnvKeys = [
  "API_INTERNAL_TOKEN",
  "OPENCOMPANY_DESKTOP_AUTH_SECRET",
  "RUNNER_CODEX_CHAT_SELF_HEAL_ENABLED",
  "RUNNER_SANDBOX_NAMESPACE",
  "WORKOS_MOBILE_CLIENT_ID",
];
const retiredEnvKeys = new Set([["RUNNER", "CLAUDE", "CODE", "ACP", "ENABLED"].join("_")]);
const expectedEnvKeys = [
  ...new Set([
    ...baseEnvKeys
      .map((key) => migratedEnvironmentName(key) ?? key)
      .filter((key) => !retiredEnvKeys.has(key)),
    ...addedEnvKeys,
  ]),
].sort();
if (currentEnvKeys.join("\n") !== expectedEnvKeys.join("\n")) {
  failures.push(".env.example: environment keys do not match the accepted hard-cut mapping");
}

if (failures.length > 0) {
  console.error("Naming boundary violations:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Naming boundary satisfied.");
  console.log(
    "Retained goat occurrences are limited to physical, historical, or compatibility contracts.",
  );
}

function trackedAndUntrackedFiles() {
  return gitLines(["ls-files", "--cached", "--others", "--exclude-standard"]);
}

function gitLines(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function gitMatchCount(pattern) {
  try {
    return execFileSync(
      "git",
      [
        "grep",
        "-I",
        "-h",
        "-o",
        "-E",
        pattern,
        "origin/main",
        "--",
        ".",
        ":(exclude)drizzle/**",
        ":(exclude)docs/adr/**",
        ":(exclude)docs/future-concepts/oss-readiness.md",
        ":(exclude)scripts/check-naming-boundary.mjs",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean).length;
  } catch (error) {
    if (error?.status === 1) return 0;
    throw error;
  }
}

function isHistorical(relativePath) {
  return historicalRoots.some((root) => relativePath.startsWith(root));
}

function envKeys(source) {
  return source
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line))
    .map((line) => line.slice(0, line.indexOf("=")))
    .sort();
}
