import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";
import { snapshotPGliteSchema } from "./test-schema-snapshot";

it("restores cached databases in UTC despite their persisted timezone", async () => {
  const builder = await PGlite.create();
  let snapshot: Blob;
  try {
    await builder.exec("ALTER SYSTEM SET TimeZone = 'Pacific/Honolulu'");
    snapshot = await builder.dumpDataDir("none");
  } finally {
    await builder.close();
  }
  const database = await createTestPGlite({ loadDataDir: snapshot });
  try {
    await expect(database.query("SHOW TimeZone")).resolves.toMatchObject({
      rows: [{ TimeZone: "UTC" }],
    });
  } finally {
    await database.close();
  }
});

it("restores schema snapshots in UTC even when their database config retains another timezone", async () => {
  const restore = await snapshotPGliteSchema(async (database) => {
    await database.exec("ALTER SYSTEM SET TimeZone = 'Pacific/Honolulu'");
    await database.exec("CREATE TABLE events (occurred_at timestamptz)");
  });
  const database = await restore();
  try {
    await database.exec("INSERT INTO events VALUES ('2026-09-01')");
    await expect(database.query("SELECT occurred_at FROM events")).resolves.toMatchObject({
      rows: [{ occurred_at: new Date("2026-09-01T00:00:00Z") }],
    });
  } finally {
    await database.close();
  }
});
