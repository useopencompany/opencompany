import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repositoryRoot, "apps/web");
const baselinePath = path.join(repositoryRoot, "scripts/web-domain-boundary-baseline.json");
const sourceExtensions = new Set([".ts", ".tsx"]);
const excludedDirectories = new Set([".next", "node_modules", "__tests__"]);
const excludedFilePattern = /\.(?:test|spec)\.[^.]+$/u;
const importPatterns = {
  dbImports:
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@opencompany\/db(?:\/[^"']*)?["']/u,
  drizzleImports:
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']drizzle-orm(?:\/[^"']*)?["']/u,
};
const forbiddenPatterns = {
  brainWorkerControl:
    /\btriggerGoat(?:BrainIngestWake|BrainImportWake|GoogleDriveSyncWake)\b|\/internal\/goat\/(?:brain-ingest\/wake|brain-import\/wake|google-drive\/sync)/u,
};
const updateBaseline = process.argv.includes("--update");

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const sourceFiles = await listSourceFiles(webRoot);
const actual = { dbImports: [], drizzleImports: [] };
const forbidden = { brainWorkerControl: [] };

for (const absolutePath of sourceFiles) {
  const source = await readFile(absolutePath, "utf8");
  const relativePath = path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
  for (const [boundary, pattern] of Object.entries(importPatterns)) {
    if (pattern.test(source)) actual[boundary].push(relativePath);
  }
  for (const [boundary, pattern] of Object.entries(forbiddenPatterns)) {
    if (pattern.test(source)) forbidden[boundary].push(relativePath);
  }
}

for (const boundary of Object.keys(importPatterns)) actual[boundary].sort();

if (updateBaseline) {
  const additions = Object.keys(importPatterns).flatMap((boundary) => {
    const expected = baseline[boundary] ?? [];
    return actual[boundary]
      .filter((file) => !expected.includes(file))
      .map((file) => `${boundary}: ${file}`);
  });
  const forbiddenCallers = Object.entries(forbidden).flatMap(([boundary, files]) =>
    files.map((file) => `${boundary}: ${file}`),
  );
  if (additions.length || forbiddenCallers.length) {
    for (const addition of additions) console.error(`Unexpected boundary addition: ${addition}`);
    for (const caller of forbiddenCallers) console.error(`Forbidden boundary caller: ${caller}`);
    console.error("The baseline updater only accepts removals from a clean boundary scan.");
    process.exit(1);
  }

  await writeFile(baselinePath, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  console.log(
    `Updated the web domain boundary baseline (${actual.dbImports.length} @opencompany/db files, ${actual.drizzleImports.length} drizzle-orm files).`,
  );
  process.exit(0);
}

let failed = false;
for (const boundary of Object.keys(importPatterns)) {
  const expected = [...(baseline[boundary] ?? [])].sort();
  const additions = actual[boundary].filter((file) => !expected.includes(file));
  const stale = expected.filter((file) => !actual[boundary].includes(file));
  if (additions.length || stale.length) {
    failed = true;
    console.error(`Web domain boundary changed for ${boundary}:`);
    for (const file of additions) console.error(`  + ${file}`);
    for (const file of stale) console.error(`  - ${file}`);
  }
}
for (const [boundary, files] of Object.entries(forbidden)) {
  if (files.length === 0) continue;
  failed = true;
  console.error(`Web domain boundary contains forbidden ${boundary} callers:`);
  for (const file of files) console.error(`  + ${file}`);
}

if (failed) {
  console.error(
    "Move new data access behind the canonical API, or update the baseline only when a cutover removes legacy imports.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `Web domain boundary unchanged (${actual.dbImports.length} @opencompany/db files, ${actual.drizzleImports.length} drizzle-orm files).`,
  );
  console.log("Web Brain import, ingestion, and Google Drive worker-control callers: 0.");
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name) || entry.name.startsWith(".")) continue;
      files.push(...(await listSourceFiles(path.join(directory, entry.name))));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!sourceExtensions.has(path.extname(entry.name)) || excludedFilePattern.test(entry.name)) {
      continue;
    }
    files.push(path.join(directory, entry.name));
  }
  return files;
}
