import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `@opencompany/protocol` exports raw TypeScript, so importing its barrel pulls
// `src/routes.ts` into the importer's program. That file holds one 198-call `.openapi()`
// chain which costs ~30s to infer, and every package that loads it re-infers it from
// scratch — including packages that only wanted a DTO. Measured on 4 vCPUs, keeping the
// router out of these programs takes chat-presentation from 50s to 3s, agent from 72s to
// 17s and runner from 79s to 23s.
//
// apps/api and apps/web consume the router contract itself, so they are allowed the
// barrel. Everything else imports `@opencompany/protocol/schemas` or `/events`, the two
// entry points that do not reach `src/routes.ts`. `/client` does reach it, through V1AppType.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  path.join(repositoryRoot, "packages/agent/src"),
  path.join(repositoryRoot, "packages/chat-presentation/src"),
  path.join(repositoryRoot, "apps/runner/src"),
];
const sourceExtensions = new Set([".ts", ".tsx"]);
const excludedDirectories = new Set([".next", "node_modules", "__tests__"]);
const protocolBarrelImport =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']@opencompany\/protocol["']/u;

const offenders = [];
for (const root of roots) {
  for (const absolutePath of await listSourceFiles(root)) {
    const source = await readFile(absolutePath, "utf8");
    if (protocolBarrelImport.test(source)) {
      offenders.push(path.relative(repositoryRoot, absolutePath).split(path.sep).join("/"));
    }
  }
}

if (offenders.length > 0) {
  console.error("Protocol router boundary violated: the @opencompany/protocol barrel re-exports");
  console.error("src/routes.ts, which adds ~30s of typecheck to every importing package.");
  for (const file of offenders) console.error(`  + ${file}`);
  console.error("Import from @opencompany/protocol/schemas or /events instead.");
  process.exitCode = 1;
} else {
  console.log("Protocol router boundary satisfied (0 barrel imports outside api/web).");
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
