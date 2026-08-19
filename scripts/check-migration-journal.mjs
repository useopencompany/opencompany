#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const drizzleDirectory = path.join(repositoryRoot, "drizzle");
const journalPath = path.join(drizzleDirectory, "meta", "_journal.json");
// Migration history is append-only, so the duplicate 0183 prefix cannot be
// renamed safely. Keep the exact historical collision visible while rejecting
// every new duplicate prefix.
const historicalDuplicatePrefixes = new Map([
  ["0183", new Set(["0183_goat_imessage_integration", "0183_goat_workflow_step_coding_settings"])],
]);

const sqlFileNames = (await readdir(drizzleDirectory)).filter((name) => name.endsWith(".sql"));
const invalidMigrationFileNames = sqlFileNames.filter((name) => !/^\d+_.+\.sql$/.test(name));
const migrationTags = sqlFileNames
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .map((name) => name.slice(0, -".sql".length))
  .sort();
const journal = JSON.parse(await readFile(journalPath, "utf8"));
const entries = Array.isArray(journal.entries) ? journal.entries : [];
const journalTags = entries.map((entry) => entry.tag);
const errors = [];

if (invalidMigrationFileNames.length > 0) {
  errors.push(`Invalid SQL migration filenames: ${invalidMigrationFileNames.join(", ")}`);
}

const baseJournal = JSON.parse(
  execFileSync("git", ["show", "origin/main:drizzle/meta/_journal.json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }),
);
const baseEntries = Array.isArray(baseJournal.entries) ? baseJournal.entries : [];
if (entries.length < baseEntries.length) {
  errors.push("The migration journal cannot remove entries from origin/main.");
} else {
  for (let index = 0; index < baseEntries.length; index += 1) {
    if (JSON.stringify(entries[index]) !== JSON.stringify(baseEntries[index])) {
      errors.push(
        `Migration journal entry ${index} differs from origin/main; history is append-only.`,
      );
    }
  }
}

const duplicateTags = journalTags.filter((tag, index) => journalTags.indexOf(tag) !== index);
if (duplicateTags.length > 0) {
  errors.push(`Duplicate journal tags: ${[...new Set(duplicateTags)].join(", ")}`);
}

const journalTagSet = new Set(journalTags);
const migrationTagSet = new Set(migrationTags);
const unjournaledMigrations = migrationTags.filter((tag) => !journalTagSet.has(tag));
if (unjournaledMigrations.length > 0) {
  errors.push(`SQL migrations missing from the journal: ${unjournaledMigrations.join(", ")}`);
}

const missingMigrationFiles = journalTags.filter((tag) => !migrationTagSet.has(tag));
if (missingMigrationFiles.length > 0) {
  errors.push(`Journal entries missing SQL files: ${missingMigrationFiles.join(", ")}`);
}

const tagsByPrefix = new Map();
for (const tag of migrationTags) {
  const prefix = tag.slice(0, tag.indexOf("_"));
  const tags = tagsByPrefix.get(prefix) ?? [];
  tags.push(tag);
  tagsByPrefix.set(prefix, tags);
}
for (const [prefix, tags] of tagsByPrefix) {
  if (tags.length < 2) continue;
  const historicalTags = historicalDuplicatePrefixes.get(prefix);
  if (
    !historicalTags ||
    tags.length !== historicalTags.size ||
    tags.some((tag) => !historicalTags.has(tag))
  ) {
    errors.push(`Duplicate migration prefix ${prefix}: ${tags.join(", ")}`);
  }
}

for (const [prefix, historicalTags] of historicalDuplicatePrefixes) {
  const currentTags = tagsByPrefix.get(prefix) ?? [];
  if (
    currentTags.length !== historicalTags.size ||
    currentTags.some((tag) => !historicalTags.has(tag))
  ) {
    errors.push(`Obsolete historical duplicate-prefix exception: ${prefix}`);
  }
}

for (let index = 0; index < entries.length; index += 1) {
  const entry = entries[index];
  if (entry.idx !== index) {
    errors.push(`Journal entry ${entry.tag ?? index} has idx ${entry.idx}; expected ${index}`);
  }
  if (index > 0 && entry.when <= entries[index - 1].when) {
    errors.push(
      `Journal timestamp for ${entry.tag ?? index} must be newer than ${entries[index - 1].tag ?? index - 1}`,
    );
  }
}

if (errors.length > 0) {
  console.error("Migration journal check failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Migration journal check passed (${journalTags.length} journaled migrations).`);
