import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../..",
  "drizzle/0288_execution_backend_compatibility.sql",
);

describe("0288 execution backend compatibility", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = await createTestPGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.codex_chat_sessions (
        id text PRIMARY KEY
      );
      CREATE TABLE goat.codex_chat_turns (
        id text PRIMARY KEY,
        codex_chat_session_id text NOT NULL REFERENCES goat.codex_chat_sessions(id),
        status text NOT NULL DEFAULT 'queued',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX goat_codex_chat_turns_claim_idx
        ON goat.codex_chat_turns (status, created_at);
      INSERT INTO goat.codex_chat_sessions (id) VALUES ('legacy_session');
      INSERT INTO goat.codex_chat_turns (id, codex_chat_session_id)
      VALUES ('legacy_run', 'legacy_session');
    `);
    const migration = await readFile(migrationPath, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  });

  afterEach(async () => database.close());

  it("backfills existing Sessions and Runs onto the established runner", async () => {
    const session = await database.query(`
      SELECT execution_backend, execution_backend_version, supervisor_template_version
      FROM goat.codex_chat_sessions WHERE id = 'legacy_session'
    `);
    const run = await database.query(`
      SELECT execution_backend, execution_backend_version
      FROM goat.codex_chat_turns WHERE id = 'legacy_run'
    `);

    expect(session.rows).toEqual([
      {
        execution_backend: "runner_attached",
        execution_backend_version: 1,
        supervisor_template_version: null,
      },
    ]);
    expect(run.rows).toEqual([
      { execution_backend: "runner_attached", execution_backend_version: 1 },
    ]);
  });

  it("requires every Run to carry the same backend version as its Session", async () => {
    await database.exec(`
      INSERT INTO goat.codex_chat_sessions (
        id, execution_backend, execution_backend_version, supervisor_template_version
      ) VALUES ('v2_session', 'sandbox_supervisor', 1, 'template-v1');
      INSERT INTO goat.codex_chat_turns (
        id, codex_chat_session_id, execution_backend, execution_backend_version
      ) VALUES ('v2_run', 'v2_session', 'sandbox_supervisor', 1);
    `);

    await expect(
      database.query(`
        INSERT INTO goat.codex_chat_turns (
          id, codex_chat_session_id, execution_backend, execution_backend_version
        ) VALUES ('mismatched_run', 'v2_session', 'runner_attached', 1)
      `),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps Session and Run execution bindings immutable", async () => {
    await expect(
      database.query(`
        UPDATE goat.codex_chat_sessions
        SET execution_backend_version = 2
        WHERE id = 'legacy_session'
      `),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.query(`
        UPDATE goat.codex_chat_turns
        SET execution_backend_version = 2
        WHERE id = 'legacy_run'
      `),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("requires a supervisor template only for supervisor-backed Sessions", async () => {
    await expect(
      database.query(`
        INSERT INTO goat.codex_chat_sessions (
          id, execution_backend, execution_backend_version
        ) VALUES ('missing_template', 'sandbox_supervisor', 1)
      `),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.query(`
        INSERT INTO goat.codex_chat_sessions (
          id, execution_backend, execution_backend_version, supervisor_template_version
        ) VALUES ('runner_with_template', 'runner_attached', 1, 'unexpected')
      `),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
