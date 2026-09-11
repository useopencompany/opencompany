import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type PGliteInterfaceExtensions, type PGliteOptions } from "@electric-sql/pglite";

/**
 * `new PGlite()` spends roughly 1.3s of its ~1.6s startup inside initdb, laying out a fresh
 * Postgres cluster. Every integration test needs a cluster and none of them need a *different*
 * one, so build it once, cache the tarball, and restore from it instead: ~330ms, extensions
 * included. Across the repo's PGlite suites that is ~40s of test time.
 *
 * The cache is keyed by PGlite version because a data directory is only loadable by the build
 * that produced it. Callers that already hold a data directory pass it to `PGlite.create`
 * directly — restoring one skips initdb for the same reason.
 */
export function createTestPGlite<O extends Omit<PGliteOptions, "loadDataDir">>(
  options?: O,
): Promise<PGlite & PGliteInterfaceExtensions<O["extensions"]>> {
  // Spreading a generic loses the link back to `O`, so restate it for the extension typing.
  type WithDataDir = O & { loadDataDir: Blob };
  return bareDataDir().then((loadDataDir) =>
    PGlite.create<WithDataDir>({ ...options, loadDataDir } as WithDataDir),
  );
}

let cached: Promise<Blob> | undefined;

function bareDataDir(): Promise<Blob> {
  cached ??= loadOrBuildBareDataDir();
  return cached;
}

async function loadOrBuildBareDataDir(): Promise<Blob> {
  const file = cacheFile();
  try {
    return new Blob([await readFile(file)]);
  } catch {
    // No usable cache yet — the first test file in a fresh checkout pays for the build.
  }

  const database = new PGlite();
  await database.waitReady;
  const snapshot = await database.dumpDataDir("none");
  await database.close();
  const bytes = Buffer.from(await snapshot.arrayBuffer());

  // Test workers start together and all miss the cache, so publish through a rename to keep
  // every reader seeing either no file or a complete one.
  const staging = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(staging, bytes);
  await rename(staging, file);

  return new Blob([bytes]);
}

function cacheFile(): string {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  return path.join(repositoryRoot, "node_modules/.cache/pglite", `${pgliteVersion()}-datadir.tar`);
}

function pgliteVersion(): string {
  const require = createRequire(import.meta.url);
  let directory = path.dirname(require.resolve("@electric-sql/pglite"));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = require(path.join(directory, "package.json"));
      if (manifest.name === "@electric-sql/pglite") return manifest.version;
    } catch {
      // Keep walking up towards the package root.
    }
    directory = path.dirname(directory);
  }
  throw new Error("Could not resolve the @electric-sql/pglite version for the data dir cache.");
}
