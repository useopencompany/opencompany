import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Wiki agent writes must cross the canonical API boundary: the runner calls the
// authenticated HTTP endpoint and the API-hosted MCP tool runs the command
// service in-process. Neither packages/agent nor apps/runner may import the wiki
// database module directly — that would bypass authentication, permission,
// validation, and idempotency. See .context/wiki-api-write-boundary-refactor-plan.md.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  path.join(repositoryRoot, "packages/agent/src"),
  path.join(repositoryRoot, "apps/runner/src"),
];
const sourceExtensions = new Set([".ts", ".tsx"]);
const excludedDirectories = new Set([".next", "node_modules", "__tests__"]);
const wikiDbImport =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']@opencompany\/db\/wiki["']/u;

const offenders = [];
for (const root of roots) {
  for (const absolutePath of await listSourceFiles(root)) {
    const source = await readFile(absolutePath, "utf8");
    if (wikiDbImport.test(source)) {
      offenders.push(path.relative(repositoryRoot, absolutePath).split(path.sep).join("/"));
    }
  }
}

if (offenders.length > 0) {
  console.error("Wiki DB boundary violated: @opencompany/db/wiki imported outside the API.");
  for (const file of offenders) console.error(`  + ${file}`);
  console.error("Route wiki commands through apps/api (runner HTTP or in-process MCP gateway).");
  process.exitCode = 1;
} else {
  console.log("Wiki DB boundary satisfied (0 @opencompany/db/wiki imports in agent/runner).");
}

async function listSourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name) || entry.name.startsWith(".")) continue;
      files.push(...(await listSourceFiles(path.join(directory, entry.name))));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!sourceExtensions.has(path.extname(entry.name))) continue;
    files.push(path.join(directory, entry.name));
  }
  return files;
}
