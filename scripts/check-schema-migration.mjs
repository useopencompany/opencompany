#!/usr/bin/env node

// Requires a numbered Drizzle migration when a packages/db schema file changes
// in a way that alters the generated SQL surface.
//
// A plain filename check ("this schema file was touched") cannot tell a DDL edit
// apart from a comment or TypeScript-identifier rename, so a repo-wide rename that
// only renames exported symbols would be forced to invent an empty migration. This
// guard instead compares a DDL projection of each schema file between the PR base
// and head: the ordered stream of quoted database identifiers plus Drizzle schema
// builder calls, with comments, whitespace, and non-builder identifiers removed.
// If that projection is unchanged, no migration is required; any table, column,
// constraint, enum value, or column-type change moves the projection and is caught.

import { execFileSync } from "node:child_process";

const repositoryRoot = new URL("..", import.meta.url).pathname;

// Current paths of the schema files that generate migrations. Comparison is
// rename-aware, so a file renamed into one of these paths is still checked
// against its pre-rename contents.
const schemaTargets = new Set([
  "packages/db/src/schema.ts",
  "packages/db/src/product-schema.ts",
  "packages/db/src/legacy-billing-schema.ts",
  "packages/db/src/llm-broker-schema.ts",
]);

// Drizzle builders whose presence (and multiplicity) reflects the generated DDL.
// Renamed exported types/consts and helper functions are intentionally absent so
// that identifier renames do not read as schema changes; column types, modifiers,
// constraints, and indexes are present so that real DDL edits do.
const builderVocabulary = new Set([
  "pgSchema",
  "pgTable",
  "pgEnum",
  "pgView",
  "pgMaterializedView",
  "pgSequence",
  "text",
  "varchar",
  "char",
  "integer",
  "smallint",
  "bigint",
  "serial",
  "bigserial",
  "smallserial",
  "boolean",
  "real",
  "doublePrecision",
  "numeric",
  "decimal",
  "timestamp",
  "date",
  "time",
  "interval",
  "json",
  "jsonb",
  "uuid",
  "inet",
  "cidr",
  "macaddr",
  "bytea",
  "line",
  "point",
  "geometry",
  "primaryKey",
  "foreignKey",
  "unique",
  "uniqueIndex",
  "index",
  "check",
  "references",
  "notNull",
  "default",
  "defaultNow",
  "defaultRandom",
  "generatedAlwaysAs",
  "generatedAlwaysAsIdentity",
  "generatedByDefaultAsIdentity",
  "array",
  "customType",
  "enum",
  "$type",
  "$default",
  "$defaultFn",
  "onDelete",
  "onUpdate",
  "using",
  "where",
  "with",
]);

const baseRef = process.env.BASE_SHA?.trim() || gitOutput(["merge-base", "origin/main", "HEAD"]);
const headRef = process.env.HEAD_SHA?.trim() || "HEAD";

const addedMigrations = gitLines([
  "diff",
  "--diff-filter=A",
  "--name-only",
  baseRef,
  headRef,
  "--",
  "drizzle",
]).some((path) => /^drizzle\/\d[^/]*\.sql$/.test(path));

const changedSchemas = [];
for (const entry of nameStatus(baseRef, headRef)) {
  const { status, basePath, headPath } = entry;
  const relevant =
    (headPath && schemaTargets.has(headPath)) || (basePath && schemaTargets.has(basePath));
  if (!relevant) continue;

  // Added or deleted schema files always alter the generated surface.
  if (status === "A" || status === "D") {
    changedSchemas.push(headPath ?? basePath);
    continue;
  }

  const baseProjection = projectDdl(fileAt(baseRef, basePath));
  const headProjection = projectDdl(fileAt(headRef, headPath));
  if (baseProjection !== headProjection) {
    changedSchemas.push(headPath);
  }
}

if (changedSchemas.length > 0 && !addedMigrations) {
  console.error(
    "A change to the generated SQL surface of a packages/db schema file requires a numbered Drizzle migration.",
  );
  for (const path of changedSchemas) console.error(`  - ${path}`);
  process.exitCode = 1;
} else if (changedSchemas.length > 0) {
  console.log(`Schema DDL changed with a migration present: ${changedSchemas.join(", ")}`);
} else {
  console.log("No packages/db schema DDL changes require a migration.");
}

// Reduce a schema module to the ordered stream of DDL-significant tokens: quoted
// database identifiers and Drizzle builder calls. Comments, whitespace, and every
// other identifier are dropped, so comment edits and symbol renames project to the
// same value while genuine DDL edits do not. Template literals are descended into:
// their static text is kept (raw SQL constraints live there) while `${...}`
// interpolations are scanned as code, so a symbol referenced inside a `sql` template
// can be renamed without moving the projection.
function projectDdl(source) {
  if (source === null) return "";
  const tokens = [];
  scanCode(source, 0, source.length, tokens);
  return tokens.join("\n");
}

// Scan a code range, emitting DDL tokens, until `end` or (when stopAtBrace) the
// matching unnested `}`. Returns the index just past where scanning stopped.
function scanCode(source, start, end, tokens, stopAtBrace = false) {
  let index = start;
  while (index < end) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "/") {
      const nl = source.indexOf("\n", index);
      index = nl === -1 || nl > end ? end : nl;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 || close > end ? end : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const value = readQuoted(source, index, char);
      tokens.push(`str:${value.text}`);
      index = value.next;
      continue;
    }
    if (char === "`") {
      index = scanTemplate(source, index, tokens);
      continue;
    }
    if (stopAtBrace && char === "}") {
      return index + 1;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let wordEnd = index + 1;
      while (wordEnd < end && /[A-Za-z0-9_$]/.test(source[wordEnd])) wordEnd += 1;
      const word = source.slice(index, wordEnd);
      if (builderVocabulary.has(word)) tokens.push(`fn:${word}`);
      index = wordEnd;
      continue;
    }
    index += 1;
  }
  return index;
}

function readQuoted(source, start, quote) {
  let index = start + 1;
  let text = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      text += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === quote) {
      index += 1;
      break;
    }
    text += char;
    index += 1;
  }
  return { text, next: index };
}

// Scan a template literal starting at the opening backtick. Emits one token for the
// concatenated static segments and scans each `${...}` interpolation as code.
function scanTemplate(source, start, tokens) {
  let index = start + 1;
  let staticText = "";
  const length = source.length;
  while (index < length) {
    const char = source[index];
    if (char === "\\") {
      staticText += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "`") {
      index += 1;
      break;
    }
    if (char === "$" && source[index + 1] === "{") {
      index = scanCode(source, index + 2, length, tokens, true);
      staticText += "${}";
      continue;
    }
    staticText += char;
    index += 1;
  }
  tokens.push(`tpl:${staticText}`);
  return index;
}

function nameStatus(base, head) {
  const raw = gitOutput(["diff", "-M", "--name-status", base, head, "--", "packages/db/src"]);
  const entries = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0][0];
    if (status === "R" || status === "C") {
      entries.push({ status: "R", basePath: parts[1], headPath: parts[2] });
    } else if (status === "A") {
      entries.push({ status: "A", basePath: null, headPath: parts[1] });
    } else if (status === "D") {
      entries.push({ status: "D", basePath: parts[1], headPath: null });
    } else {
      entries.push({ status: "M", basePath: parts[1], headPath: parts[1] });
    }
  }
  return entries;
}

function fileAt(ref, path) {
  if (!path) return null;
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function gitLines(args) {
  return gitOutput(args).split("\n").filter(Boolean);
}

function gitOutput(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}
