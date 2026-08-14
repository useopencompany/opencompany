import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "@opencompany/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startBrainImportRunIdempotent } from "./brain-import";

const migrationPaths = [
  "drizzle/0208_goat_headless_knowledge_idempotency.sql",
  "drizzle/0209_goat_brain_asset_idempotency.sql",
  "drizzle/0210_goat_skill_import_idempotency.sql",
  "drizzle/0212_goat_brain_import_idempotency.sql",
].map((migration) => path.resolve(import.meta.dirname, "../../..", migration));

describe("startBrainImportRunIdempotent", () => {
  let database: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(BASE_SCHEMA);
    for (const migrationPath of migrationPaths) {
      const migration = await readFile(migrationPath, "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
    db = drizzle(database);
  });

  beforeEach(async () => {
    await database.exec(`
      DELETE FROM goat.knowledge_command_idempotency;
      DELETE FROM goat.brain_import_runs;
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("creates one run and replays the same command durably", async () => {
    const command = {
      actor: actor(),
      brainRef: "brain_1",
      idempotencyKey: "import-1",
      companyUrl: "acme.com",
      focus: "Product",
      sourceSelection: { public_web: { enabled: true } },
      db,
    };

    const created = await startBrainImportRunIdempotent(command);
    const replay = await startBrainImportRunIdempotent(command);

    expect(created.idempotentReplay).toBe(false);
    expect(created.run.companyUrl).toBe("https://acme.com");
    expect(created.run.companyDomain).toBe("acme.com");
    expect(created.run.status).toBe("discovering");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.run.id).toBe(created.run.id);
    await expect(
      database.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM goat.brain_import_runs",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("rejects key reuse for a different normalized command", async () => {
    const command = {
      actor: actor(),
      brainRef: "brain_1",
      idempotencyKey: "import-1",
      companyUrl: "acme.com",
      sourceSelection: { public_web: { enabled: true } },
      db,
    };
    await startBrainImportRunIdempotent(command);

    await expect(
      startBrainImportRunIdempotent({ ...command, companyUrl: "other.com" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("keeps one active import per brain the storage invariant", async () => {
    const base = {
      actor: actor(),
      brainRef: "brain_1",
      companyUrl: "acme.com",
      sourceSelection: { public_web: { enabled: true } },
      db,
    };
    await startBrainImportRunIdempotent({ ...base, idempotencyKey: "import-1" });

    await expect(
      startBrainImportRunIdempotent({ ...base, idempotencyKey: "import-2" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "An import is already running for this brain.",
    });

    await database.query(
      "UPDATE goat.brain_import_runs SET status = 'canceled', completed_at = now()",
    );
    const next = await startBrainImportRunIdempotent({
      ...base,
      idempotencyKey: "import-3",
    });
    expect(next.idempotentReplay).toBe(false);
  });

  it("recovers a reservation whose run insert was lost", async () => {
    const command = {
      actor: actor(),
      brainRef: "brain_1",
      idempotencyKey: "import-1",
      companyUrl: "acme.com",
      sourceSelection: { public_web: { enabled: true } },
      db,
    };
    const created = await startBrainImportRunIdempotent(command);
    await database.query("DELETE FROM goat.brain_import_runs WHERE id = $1", [created.run.id]);

    const recovered = await startBrainImportRunIdempotent(command);
    expect(recovered.run.id).toBe(created.run.id);
    expect(recovered.idempotentReplay).toBe(false);
  });

  it("scopes the same idempotency key independently per actor and Workspace", async () => {
    const first = await startBrainImportRunIdempotent({
      actor: actor(),
      brainRef: "brain_1",
      idempotencyKey: "same-key",
      companyUrl: "acme.com",
      sourceSelection: { public_web: { enabled: true } },
      db,
    });
    const second = await startBrainImportRunIdempotent({
      actor: actor({ userId: "user_2", workspaceId: "workspace_2" }),
      brainRef: "brain_2",
      idempotencyKey: "same-key",
      companyUrl: "acme.com",
      sourceSelection: { public_web: { enabled: true } },
      db,
    });

    expect(second.run.id).not.toBe(first.run.id);
    await expect(
      database.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM goat.brain_import_runs",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("rejects unsafe or invalid company websites", async () => {
    await expect(
      startBrainImportRunIdempotent({
        actor: actor(),
        brainRef: "brain_1",
        idempotencyKey: "import-unsafe",
        companyUrl: "http://169.254.169.254/latest",
        sourceSelection: {},
        db,
      }),
    ).rejects.toThrow("Enter a public company website.");
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "admin",
    permissions: ["brain:read"],
    authenticationMethod: "session",
    ...overrides,
  };
}

const BASE_SCHEMA = `
CREATE SCHEMA goat;
CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
CREATE TABLE goat.workspaces (id text PRIMARY KEY);
INSERT INTO goat.users (workos_user_id) VALUES ('user_1'), ('user_2');
INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_2');
CREATE TABLE goat.brains (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE
);
INSERT INTO goat.brains (id, workspace_id)
  VALUES ('brain_1', 'workspace_1'), ('brain_2', 'workspace_2');
CREATE TABLE goat.brain_import_runs (
  id text PRIMARY KEY,
  brain_ref text NOT NULL REFERENCES goat.brains(id) ON DELETE CASCADE,
  user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
  company_url text NOT NULL,
  company_domain text NOT NULL,
  company_name text,
  focus text,
  history_start_at timestamptz NOT NULL,
  history_end_at timestamptz NOT NULL,
  source_selection jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovery_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'discovering',
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  confirmed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX goat_brain_import_runs_active_brain_idx
  ON goat.brain_import_runs (brain_ref)
  WHERE status IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing');
`;
