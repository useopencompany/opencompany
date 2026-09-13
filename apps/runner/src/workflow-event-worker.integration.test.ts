import { PGlite } from "@electric-sql/pglite";
import {
  enqueueWorkflowEventRuns,
  listWorkflowEventTriggerRoutes,
} from "@opencompany/db/workflow-event-routes";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNextWorkflowEventTask } from "./workflow-event-worker";

describe("durable plugin event delivery", () => {
  const database = new PGlite();
  const db = drizzle(database);
  const now = new Date("2026-09-12T20:00:00Z");
  beforeAll(async () => {
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.users (workos_user_id text PRIMARY KEY, task_spawning_enabled boolean, onboarded_at timestamptz);
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text);
      CREATE TABLE goat.integrations (id text PRIMARY KEY, provider text, workspace_id text, user_workos_id text, status text, external_id text);
      CREATE TABLE goat.plugins (workspace_id text, owner_user_id text, name text, status text, archived_at timestamptz, events jsonb, event_modes jsonb);
      CREATE TABLE goat.workflows (id text PRIMARY KEY, workspace_id text, slug text, name text, trigger text, status text, archived_at timestamptz, event_user_workos_id text, event_config jsonb, event_harness_spec jsonb, event_activated_at timestamptz);
      CREATE TABLE goat.tasks (id text PRIMARY KEY);
      CREATE TABLE goat.workflow_event_runs (
        id text PRIMARY KEY, workflow_id text REFERENCES goat.workflows(id), workspace_id text, user_workos_id text,
        workflow_slug text, workflow_name text, provider text, event_type text, delivery_id text, goal text, harness_spec jsonb, event_at timestamptz,
        task_id text REFERENCES goat.tasks(id), status text DEFAULT 'pending', attempt_count int DEFAULT 0,
        next_attempt_at timestamptz DEFAULT '2026-09-12T20:00:00Z', last_error text,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE (workflow_id, provider, delivery_id)
      );
    `);
  }, 30_000);
  afterAll(() => database.close());
  beforeEach(async () => {
    await database.exec(`
      TRUNCATE goat.workflow_event_runs, goat.tasks, goat.workflows, goat.plugins, goat.integrations, goat.workspace_members, goat.users CASCADE;
      INSERT INTO goat.users VALUES ('user_1', true, now());
      INSERT INTO goat.workspace_members VALUES ('workspace_1', 'user_1');
      INSERT INTO goat.integrations VALUES ('connection_1', 'linear', NULL, 'user_1', 'connected', 'organization_1');
      INSERT INTO goat.plugins VALUES ('workspace_1', 'user_1', 'linear', 'enabled', NULL, '[{"id":"issue.created","filters":[]}]', '{"issue.created":true}');
      INSERT INTO goat.workflows VALUES ('workflow_1', 'workspace_1', 'issue-review', 'Review issue', 'event', 'active', NULL, 'user_1',
        '{"type":"event","provider":"linear","event":"issue.created","integrationId":"connection_1","filters":{},"prompt":"Review this issue."}', '{}', '2026-09-12T19:00:00Z');
    `);
  });
  async function enqueue(eventAt = now, deliveryId = "delivery_1") {
    const routes = await listWorkflowEventTriggerRoutes(
      {
        provider: "linear",
        integrations: [
          { id: "connection_1", workspaceId: null, userWorkosId: "user_1", status: "connected" },
        ],
      },
      db,
    );
    return enqueueWorkflowEventRuns(
      {
        routes,
        deliveryId,
        eventAt,
        context: { tag: "linear_issue_context", lines: ["Title: Test issue"] },
      },
      db,
    );
  }
  it("ignores events before activation and deduplicates a provider retry", async () => {
    expect(await enqueue(new Date("2026-09-12T18:00:00Z"), "historical")).toBe(0);
    expect(await enqueue()).toBe(1);
    expect(await enqueue()).toBe(0);
    const createTask = vi.fn<
      NonNullable<NonNullable<Parameters<typeof createNextWorkflowEventTask>[1]>["createTask"]>
    >(async (tx) => {
      await tx.execute(sql`INSERT INTO goat.tasks VALUES ('task_1')`);
      return { taskId: "task_1" };
    });
    expect(await createNextWorkflowEventTask(now, { db: db as never, createTask })).toMatchObject({
      status: "created",
    });
    expect(await createNextWorkflowEventTask(now, { db: db as never, createTask })).toEqual({
      status: "none",
    });
    expect(createTask).toHaveBeenCalledOnce();
    expect(createTask.mock.calls[0]?.[1]).toMatchObject({ workflowSlug: "issue-review" });
  });
  it.each([
    "UPDATE goat.plugins SET event_modes = '{}'",
    "UPDATE goat.plugins SET events = '[]'",
    "UPDATE goat.workflows SET status = 'draft'",
    "UPDATE goat.integrations SET status = 'disconnected'",
    "DELETE FROM goat.workspace_members",
    "UPDATE goat.workflows SET event_activated_at = '2026-09-12T21:00:00Z'",
  ])("reauthorizes queued events before task creation: %s", async (mutation) => {
    await enqueue();
    await database.exec(mutation);
    const createTask = vi.fn();
    expect(await createNextWorkflowEventTask(now, { db: db as never, createTask })).toMatchObject({
      status: "ignored",
    });
    expect(createTask).not.toHaveBeenCalled();
  });
  it("rolls back partial task writes before recording retry after a SQL error", async () => {
    await enqueue();
    const result = await createNextWorkflowEventTask(now, {
      db: db as never,
      createTask: async (tx) => {
        await tx.execute(sql`INSERT INTO goat.tasks VALUES ('partial_task')`);
        await tx.execute(sql`SELECT 1 / 0`);
        return { taskId: "partial_task" };
      },
    });
    expect(result).toMatchObject({ status: "retry" });
    expect((await database.query("SELECT * FROM goat.tasks")).rows).toEqual([]);
    expect(
      (await database.query("SELECT status, attempt_count FROM goat.workflow_event_runs")).rows,
    ).toEqual([{ status: "pending", attempt_count: 1 }]);
  });
});
