import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repositoryRoot, "apps/web");
const sourceExtensions = new Set([".ts", ".tsx"]);
const excludedDirectories = new Set([".next", "node_modules", "__tests__"]);
const excludedFilePattern = /\.(?:test|spec)\.[^.]+$/u;
const importPatterns = {
  dbImports:
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']@opencompany\/db(?:\/[^"']*)?["']/u,
  drizzleImports:
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']drizzle-orm(?:\/[^"']*)?["']/u,
};
const forbiddenPatterns = {
  brainWorkerControl:
    /\btriggerGoat(?:BrainIngestWake|BrainImportWake|GoogleDriveSyncWake)\b|\/internal\/goat\/(?:brain-ingest\/wake|brain-import\/wake|google-drive\/sync)/u,
};

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

let failed = false;
for (const boundary of Object.keys(importPatterns)) {
  if (actual[boundary].length === 0) continue;
  failed = true;
  console.error(`Web domain boundary contains forbidden ${boundary}:`);
  for (const file of actual[boundary]) console.error(`  + ${file}`);
}
for (const [boundary, files] of Object.entries(forbidden)) {
  if (files.length === 0) continue;
  failed = true;
  console.error(`Web domain boundary contains forbidden ${boundary} callers:`);
  for (const file of files) console.error(`  + ${file}`);
}

if (failed) {
  console.error("Production web data access must stay behind the canonical API.");
  process.exitCode = 1;
} else {
  console.log("Web domain boundary final rule satisfied (0 @opencompany/db, 0 drizzle-orm).");
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
