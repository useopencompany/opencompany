import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  completeImessageLink,
  deleteImessageBinding,
  findLinkedImessageBinding,
  getImessageBinding,
  startImessageLink,
} from "./imessage";
import { createTestPGlite } from "./test-pglite";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../..",
  "drizzle/0299_imessage_personal_agent.sql",
);

describe("iMessage binding lifecycle", () => {
  let database: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    database = await createTestPGlite();
    await database.exec(BASE_SCHEMA);
    const migration = await readFile(migrationPath, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
    db = drizzle(database);
  });

  beforeEach(async () => {
    await database.exec(`
      DELETE FROM goat.imessage_bindings;
      DELETE FROM goat.codex_chat_sessions;
      DELETE FROM goat.chat_sessions;
      DELETE FROM goat.workspace_members;
      DELETE FROM goat.workspaces;
      DELETE FROM goat.users;
      INSERT INTO goat.users (workos_user_id, imessage_enabled)
      VALUES ('enabled_user', true), ('disabled_user', false);
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1');
      INSERT INTO goat.workspace_members (workspace_id, user_workos_id, role)
      VALUES ('workspace_1', 'enabled_user', 'member');
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("pairs a member and creates exactly one personal-agent conversation", async () => {
    const requestedAt = new Date("2026-09-16T12:00:00Z");
    const pending = await startImessageLink(
      { userWorkosId: "enabled_user", workspaceId: "workspace_1", now: requestedAt },
      db,
    );
    expect(pending).toMatchObject({ status: "pending", workspaceId: "workspace_1" });
    expect(pending.linkCode).toMatch(/^\d{6}$/);

    const linked = await completeImessageLink(
      {
        code: pending.linkCode!,
        handle: "+15551234567",
        model: "moonshotai/kimi-k3",
        now: new Date("2026-09-16T12:01:00Z"),
      },
      db,
    );
    expect(linked).toMatchObject({
      status: "linked",
      handle: "+15551234567",
      linkCode: null,
      workspaceId: "workspace_1",
    });
    expect(linked?.conversationId).toMatch(/^conversation_/);

    const resolved = await findLinkedImessageBinding({ handle: "+15551234567" }, db);
    expect(resolved).toMatchObject({ imessageEnabled: true, workspaceRole: "member" });
    const { rows: runtimes } = await database.query<{
      harness: string;
      engine: string;
      workspace_id: string;
    }>(
      "SELECT harness, engine, workspace_id FROM goat.codex_chat_sessions WHERE chat_session_id = $1",
      [linked!.conversationId],
    );
    expect(runtimes).toEqual([
      { harness: "personal_agent", engine: "opencompany", workspace_id: "workspace_1" },
    ]);

    await deleteImessageBinding({ userWorkosId: "enabled_user" }, db);
    expect(await getImessageBinding({ userWorkosId: "enabled_user" }, db)).toBeNull();
    const { rows: conversations } = await database.query<{ id: string }>(
      "SELECT id FROM goat.chat_sessions WHERE id = $1",
      [linked!.conversationId],
    );
    expect(conversations).toEqual([{ id: linked!.conversationId }]);
  });

  it("refuses expired codes and members whose feature was disabled", async () => {
    const requestedAt = new Date("2026-09-16T12:00:00Z");
    const expired = await startImessageLink(
      { userWorkosId: "enabled_user", workspaceId: "workspace_1", now: requestedAt },
      db,
    );
    expect(
      await completeImessageLink(
        {
          code: expired.linkCode!,
          handle: "+15550000001",
          model: "moonshotai/kimi-k3",
          now: new Date("2026-09-16T12:11:00Z"),
        },
        db,
      ),
    ).toBeNull();

    const disabled = await startImessageLink(
      { userWorkosId: "disabled_user", workspaceId: "workspace_1", now: requestedAt },
      db,
    );
    expect(
      await completeImessageLink(
        {
          code: disabled.linkCode!,
          handle: "+15550000002",
          model: "moonshotai/kimi-k3",
          now: new Date("2026-09-16T12:01:00Z"),
        },
        db,
      ),
    ).toBeNull();
  });
});

const BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.users (
    workos_user_id text PRIMARY KEY
  );
  CREATE TABLE goat.workspaces (
    id text PRIMARY KEY
  );
  CREATE TABLE goat.workspace_members (
    workspace_id text NOT NULL,
    user_workos_id text NOT NULL,
    role text NOT NULL
  );
  CREATE TABLE goat.chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    project_id text,
    title text NOT NULL DEFAULT 'New chat',
    bot_name text,
    bot_description text,
    model text NOT NULL,
    engine text NOT NULL DEFAULT 'opencompany',
    kind text NOT NULL DEFAULT 'chat',
    closed_at timestamptz,
    pinned_at timestamptz,
    last_seen_at timestamptz,
    has_unseen boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    chat_session_id text NOT NULL,
    engine text NOT NULL DEFAULT 'codex',
    model text NOT NULL DEFAULT 'gpt-5.5',
    brain_ref text,
    workspace_id text,
    host_tool_contract_version text,
    execution_backend text NOT NULL DEFAULT 'runner_attached',
    execution_backend_version integer NOT NULL DEFAULT 1,
    supervisor_template_version text,
    sandbox_id text,
    sandbox_size text NOT NULL DEFAULT 'standard',
    codex_thread_id text,
    active_turn_id text,
    status text NOT NULL DEFAULT 'queued',
    error text,
    sandbox_timeout_armed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;
