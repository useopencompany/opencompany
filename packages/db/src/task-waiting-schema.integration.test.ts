import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("0234 goat Task waiting status", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.tasks (
        id text PRIMARY KEY,
        status text NOT NULL,
        CONSTRAINT goat_tasks_status_check
          CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled'))
      );
    `);
    const migration = await readFile(
      path.resolve(import.meta.dirname, "../../..", "drizzle/0234_goat_task_waiting_status.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  });

  afterEach(async () => database.close());

  it("accepts waiting while retaining the physical status constraint", async () => {
    await expect(
      database.query("INSERT INTO goat.tasks (id, status) VALUES ('waiting_task', 'waiting')"),
    ).resolves.toBeDefined();
    await expect(
      database.query("INSERT INTO goat.tasks (id, status) VALUES ('invalid_task', 'blocked')"),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
