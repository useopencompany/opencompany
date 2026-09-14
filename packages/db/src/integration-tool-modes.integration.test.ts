import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyIntegrationCapabilityMode, applyIntegrationToolMode } from "./integrations";
import { integrations } from "./product-schema";
import { createTestPGlite } from "./test-pglite";

// applyIntegrationToolMode is the one place a raw jsonb expression decides whether a permission
// key survives, so it is exercised against a real Postgres rather than a mocked update builder.
describe("per-tool permission overrides", () => {
  let database: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    database = await createTestPGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.integrations (
        id text PRIMARY KEY, user_workos_id text NOT NULL, workspace_id text,
        shared_with_workspace boolean NOT NULL DEFAULT false, provider text NOT NULL,
        external_id text NOT NULL, connection_label text, account_name text, account_email text,
        account_type text, status text NOT NULL DEFAULT 'connected', status_reason text,
        scopes jsonb NOT NULL DEFAULT '[]',
        capability_modes jsonb NOT NULL DEFAULT '{}',
        tool_modes jsonb NOT NULL DEFAULT '{}',
        last_synced_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT integrations_tool_modes_check CHECK (jsonb_typeof(tool_modes) = 'object')
      );
    `);
    db = drizzle(database);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM goat.integrations;");
    await database.exec(
      "INSERT INTO goat.integrations (id, user_workos_id, provider, external_id) VALUES ('gint_1','user_1','gmail','ext_1'), ('gint_2','user_1','gmail','ext_2');",
    );
  });

  const read = async (id: string) => {
    const [row] = await db
      .select({ toolModes: integrations.toolModes, capabilityModes: integrations.capabilityModes })
      .from(integrations)
      .where(eq(integrations.id, id));
    return row!;
  };

  it("stores an override and leaves the capability modes alone", async () => {
    await applyIntegrationCapabilityMode({
      integrationIds: ["gint_1"],
      capabilityId: "write",
      mode: "on",
      db,
    });
    await applyIntegrationToolMode({
      integrationIds: ["gint_1"],
      toolId: "trash_thread",
      mode: "ask",
      db,
    });
    const row = await read("gint_1");
    expect(row.toolModes).toEqual({ trash_thread: "ask" });
    expect(row.capabilityModes).toEqual({ write: "on" });
  });

  it("merges further overrides without dropping the existing keys", async () => {
    for (const [toolId, mode] of [
      ["trash_thread", "ask"],
      ["trash_message", "off"],
    ] as const) {
      await applyIntegrationToolMode({ integrationIds: ["gint_1"], toolId, mode, db });
    }
    expect((await read("gint_1")).toolModes).toEqual({
      trash_thread: "ask",
      trash_message: "off",
    });
  });

  it("removes only the named key when a tool is released back to its group", async () => {
    for (const [toolId, mode] of [
      ["trash_thread", "ask"],
      ["trash_message", "off"],
    ] as const) {
      await applyIntegrationToolMode({ integrationIds: ["gint_1"], toolId, mode, db });
    }
    await applyIntegrationToolMode({
      integrationIds: ["gint_1"],
      toolId: "trash_thread",
      mode: null,
      db,
    });
    expect((await read("gint_1")).toolModes).toEqual({ trash_message: "off" });
  });

  it("is a no-op when clearing a tool that was never overridden", async () => {
    await applyIntegrationToolMode({
      integrationIds: ["gint_1"],
      toolId: "never_set",
      mode: null,
      db,
    });
    // The check constraint requires an object, so an unset clear must not produce null.
    expect((await read("gint_1")).toolModes).toEqual({});
  });

  it("touches only the named connections", async () => {
    await applyIntegrationToolMode({
      integrationIds: ["gint_1"],
      toolId: "trash_thread",
      mode: "off",
      db,
    });
    expect((await read("gint_2")).toolModes).toEqual({});
  });

  it("does nothing when no connection is named", async () => {
    await applyIntegrationToolMode({ integrationIds: [], toolId: "trash_thread", mode: "off", db });
    expect((await read("gint_1")).toolModes).toEqual({});
  });
});
