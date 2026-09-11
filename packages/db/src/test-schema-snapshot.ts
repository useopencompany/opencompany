import { PGlite } from "@electric-sql/pglite";
import { createTestPGlite } from "./test-pglite";

/**
 * Integration tests that assert against migrations need an untouched database per test, but
 * replaying the migration files to get one costs ~1.6s while restoring a dumped data directory
 * costs ~325ms. Build the schema once per test file through this helper and restore a snapshot of
 * it for each test instead.
 *
 * The returned snapshot is an immutable blob, so every restore yields an independent database and
 * writes made by one test are invisible to the next.
 */
export async function snapshotPGliteSchema(
  build: (database: PGlite) => Promise<unknown>,
): Promise<() => Promise<PGlite>> {
  const builder = await createTestPGlite();
  try {
    await build(builder);
    // These snapshots live in memory for the duration of one test file, so compressing them would
    // trade the restore time this helper exists to save for memory nobody is short of.
    const snapshot = await builder.dumpDataDir("none");
    return () => PGlite.create({ loadDataDir: snapshot });
  } finally {
    await builder.close();
  }
}
