import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds Outlook providers without removing existing integration providers", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE SCHEMA goat");
    const tables = ["integrations", "integration_credentials", "integration_resources"];
    for (const table of tables) {
      await db.exec(
        `CREATE TABLE "goat".${table} (provider text CONSTRAINT goat_${table}_provider_check CHECK (provider IN ('gmail')))`,
      );
    }

    for (const migration of [
      "0262_opencompany_convex_integration.sql",
      "0266_google_admin_integration.sql",
      "0270_outlook_integrations.sql",
    ]) {
      const sql = await readFile(new URL(`../../../drizzle/${migration}`, import.meta.url), "utf8");
      await db.exec(sql);
    }

    for (const table of tables) {
      await db.exec(
        `INSERT INTO "goat".${table} VALUES ('gmail'), ('convex'), ('google_admin'), ('outlook'), ('outlook-calendar')`,
      );
      await expect(
        db.exec(`INSERT INTO "goat".${table} VALUES ('unknown_provider')`),
      ).rejects.toThrow();
    }
    expect(
      (await db.query("SELECT provider FROM goat.integrations ORDER BY provider")).rows,
    ).toEqual([
      { provider: "convex" },
      { provider: "gmail" },
      { provider: "google_admin" },
      { provider: "outlook" },
      { provider: "outlook-calendar" },
    ]);
  } finally {
    await db.close();
  }
});
