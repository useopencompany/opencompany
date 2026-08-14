#!/usr/bin/env node

// DESTRUCTIVE cleanup: remove the reserved `workflows/` and `skills/` folders and
// their documents from every Brain, now that Workflows and Skills live in their
// own workspace-scoped tables (goat.workflows / goat.skills).
//
// Run this ONLY after backfill-workflows-skills.ts has run and been verified
// (row counts in the new tables match the Brain docs). Deleting first would lose
// content. Timeline entries / edges referencing these docs cascade on delete.
//
// Idempotent: a re-run finds nothing left and deletes 0.
//
// Usage: DATABASE_URL=postgres://... node scripts/cleanup-brain-workflows-skills.mjs

import { exit } from "node:process";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set DATABASE_URL to the target database before running the cleanup.");
  exit(1);
}

const sql = neon(databaseUrl);

const [{ count: docCount }] = await sql`
  SELECT COUNT(*)::int AS count FROM goat.brain_documents
  WHERE folder_path = 'workflows' OR folder_path LIKE 'workflows/%'
     OR folder_path = 'skills' OR folder_path LIKE 'skills/%'
`;
const [{ count: folderCount }] = await sql`
  SELECT COUNT(*)::int AS count FROM goat.brain_folders
  WHERE path = 'workflows' OR path LIKE 'workflows/%'
     OR path = 'skills' OR path LIKE 'skills/%'
`;
console.log(`Found ${docCount} document(s) and ${folderCount} folder row(s) to remove.`);

const deletedDocs = await sql`
  DELETE FROM goat.brain_documents
  WHERE folder_path = 'workflows' OR folder_path LIKE 'workflows/%'
     OR folder_path = 'skills' OR folder_path LIKE 'skills/%'
  RETURNING id
`;
const deletedFolders = await sql`
  DELETE FROM goat.brain_folders
  WHERE path = 'workflows' OR path LIKE 'workflows/%'
     OR path = 'skills' OR path LIKE 'skills/%'
  RETURNING brain_ref, path
`;

console.log(
  `Deleted ${deletedDocs.length} document(s) and ${deletedFolders.length} folder row(s).`,
);
exit(0);
