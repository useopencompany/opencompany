#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const drizzleDirectory = path.join(repositoryRoot, "drizzle");
const journalPath = path.join(drizzleDirectory, "meta", "_journal.json");
// This historical data migration predates the guard and may have been applied
// manually. Registering it now would make Drizzle re-run destructive cleanup.
const legacyUnjournaledMigrations = new Set(["0102_goat_brain_folder_defaults"]);

const migrationTags = (await readdir(drizzleDirectory))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .map((name) => name.slice(0, -".sql".length))
  .sort();
const journal = JSON.parse(await readFile(journalPath, "utf8"));
const entries = Array.isArray(journal.entries) ? journal.entries : [];
const journalTags = entries.map((entry) => entry.tag);
const errors = [];

const duplicateTags = journalTags.filter((tag, index) => journalTags.indexOf(tag) !== index);
if (duplicateTags.length > 0) {
  errors.push(`Duplicate journal tags: ${[...new Set(duplicateTags)].join(", ")}`);
}

const journalTagSet = new Set(journalTags);
const migrationTagSet = new Set(migrationTags);
const unjournaledMigrations = migrationTags.filter(
  (tag) => !journalTagSet.has(tag) && !legacyUnjournaledMigrations.has(tag),
);
if (unjournaledMigrations.length > 0) {
  errors.push(`SQL migrations missing from the journal: ${unjournaledMigrations.join(", ")}`);
}

const missingMigrationFiles = journalTags.filter((tag) => !migrationTagSet.has(tag));
if (missingMigrationFiles.length > 0) {
  errors.push(`Journal entries missing SQL files: ${missingMigrationFiles.join(", ")}`);
}

const obsoleteLegacyExceptions = [...legacyUnjournaledMigrations].filter(
  (tag) => !migrationTagSet.has(tag) || journalTagSet.has(tag),
);
if (obsoleteLegacyExceptions.length > 0) {
  errors.push(`Obsolete legacy exceptions: ${obsoleteLegacyExceptions.join(", ")}`);
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

console.log(
  `Migration journal check passed (${journalTags.length} journaled migrations, ${legacyUnjournaledMigrations.size} historical exception).`,
);
