import { createTestPGlite } from "@opencompany/db/test-pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { listWorkflowCatalog, listWorkflows, resolveWorkflowMention } from "./workflows";

// Company agents share the automation table with workflows, but every reader here ultimately runs
// a row as the *caller*. An agent must run as its owner instead, with the resulting work owned by
// the agent. So an agent reaching any of these paths is an authorization bug, not a cosmetic one:
// it would execute on the caller's connected accounts and land in the caller's personal Task list.
let db: Awaited<ReturnType<typeof createTestPGlite>>;
// The production readers are typed against the Neon client; PGlite satisfies every query
// they issue, so the fixture is cast once here rather than widening the production signature.
let client: NonNullable<Parameters<typeof listWorkflowCatalog>[2]>;

beforeAll(async () => {
  db = await createTestPGlite();
  await db.exec(`
    CREATE SCHEMA goat;
    CREATE TABLE goat.workflows (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      slug text NOT NULL,
      kind text NOT NULL DEFAULT 'workflow',
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      instructions text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT '',
      steps jsonb NOT NULL DEFAULT '[]'::jsonb,
      scope text NOT NULL DEFAULT 'company',
      status text NOT NULL DEFAULT 'active',
      created_by_workos_id text,
      trigger text NOT NULL DEFAULT 'manual',
      automation_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
      schedule_cron text,
      schedule_timezone text NOT NULL DEFAULT 'UTC',
      schedule_prompt text NOT NULL DEFAULT '',
      schedule_enabled boolean NOT NULL DEFAULT false,
      schedule_last_run_at timestamptz,
      schedule_next_run_at timestamptz,
      archived_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO goat.workflows (id, workspace_id, slug, kind, name, description, steps) VALUES
      ('workflow_1', 'workspace_1', 'weekly-research', 'workflow', 'Weekly research', 'Tracks changes',
        '[{"id":"step_1","title":"Research","model":"provider/model","instructions":"Find changes."}]'::jsonb),
      ('agent_1', 'workspace_1', 'pr-reviewer', 'agent', 'PR Reviewer', 'Reviews pull requests',
        '[{"id":"agent_1-instructions","title":"","model":"provider/model","instructions":"Review the diff."}]'::jsonb);
  `);
  client = drizzle(db) as unknown as NonNullable<Parameters<typeof listWorkflowCatalog>[2]>;
}, 20000);

describe("Company agents are unreachable through workflow run paths", () => {
  it("keeps agents out of the chat workflow catalog", async () => {
    const catalog = await listWorkflowCatalog("workspace_1", "user_1", client);
    expect(catalog.map((entry) => entry.id)).toEqual(["weekly-research"]);
  });

  it("keeps agents out of the workflow list", async () => {
    const list = await listWorkflows("workspace_1", "user_1", client);
    expect(list.map((entry) => entry.name)).toEqual(["Weekly research"]);
  });

  it("refuses to resolve an agent as a workflow mention", async () => {
    await expect(
      resolveWorkflowMention({
        workspaceId: "workspace_1",
        userId: "user_1",
        mention: { id: "pr-reviewer" },
        db: client,
      }),
    ).rejects.toThrow(/unavailable|not found/iu);
    // The control: the same call for a real workflow still resolves.
    await expect(
      resolveWorkflowMention({
        workspaceId: "workspace_1",
        userId: "user_1",
        mention: { id: "weekly-research" },
        db: client,
      }),
    ).resolves.toMatchObject({ id: "weekly-research" });
  });
});
