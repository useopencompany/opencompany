import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds Google Admin to the integration vault without removing existing provider rows", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE SCHEMA goat");
    const tables = ["integrations", "integration_credentials", "integration_resources"];
    for (const table of tables) {
      await db.exec(
        `CREATE TABLE goat.${table} (provider text CONSTRAINT goat_${table}_provider_check CHECK (provider IN ('gmail')))`,
      );
    }
    for (const migration of [
      "0262_opencompany_convex_integration.sql",
      "0265_google_admin_integration.sql",
    ]) {
      const sql = await readFile(new URL(`../../../drizzle/${migration}`, import.meta.url), "utf8");
      if (migration.startsWith("0265")) {
        await expect(
          db.exec("INSERT INTO goat.integrations VALUES ('google_admin')"),
        ).rejects.toThrow();
        await db.exec("INSERT INTO goat.integrations VALUES ('gmail'), ('convex')");
      }
      await db.exec(sql);
    }
    for (const table of tables) {
      await db.exec(`INSERT INTO goat.${table} VALUES ('google_admin')`);
      await expect(
        db.exec(`INSERT INTO goat.${table} VALUES ('unknown_provider')`),
      ).rejects.toThrow();
    }
    expect(
      (await db.query("SELECT provider FROM goat.integrations ORDER BY provider")).rows,
    ).toEqual([{ provider: "convex" }, { provider: "gmail" }, { provider: "google_admin" }]);
  } finally {
    await db.close();
  }
});
