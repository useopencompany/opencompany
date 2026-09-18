import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listGranolaPollCandidates, pollGranolaIntegration } from "./granola-poll-worker";
import { createNextWorkflowEventTask } from "./workflow-event-worker";

const dependencies = vi.hoisted(() => ({ getDb: vi.fn(), loadCredential: vi.fn() }));
vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadIntegrationCredential: dependencies.loadCredential,
}));

describe("Granola polling through the durable workflow event inbox", () => {
  const database = new PGlite();
  const db = drizzle(database);
  const candidate = { integrationId: "connection_1", userWorkosId: "user_1" };
  let noteUpdatedAt: Date;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.users (workos_user_id text PRIMARY KEY, onboarded_at timestamptz);
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text);
      CREATE TABLE goat.integrations (id text PRIMARY KEY, provider text, workspace_id text, user_workos_id text, status text, external_id text);
      CREATE TABLE goat.plugins (workspace_id text, owner_user_id text, name text, status text, archived_at timestamptz, events jsonb, event_modes jsonb);
      CREATE TABLE goat.workflows (id text PRIMARY KEY, workspace_id text, slug text, name text, trigger text, status text, archived_at timestamptz, event_user_workos_id text, event_config jsonb, event_harness_spec jsonb, event_activated_at timestamptz, automation_triggers jsonb NOT NULL DEFAULT '[]'::jsonb, kind text NOT NULL DEFAULT 'workflow');
      CREATE TABLE goat.granola_sync_state (
        integration_id text PRIMARY KEY, user_workos_id text, updated_after_cursor timestamptz,
        page_cursor text, pending_updated_after_cursor timestamptz, last_polled_at timestamptz,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE goat.tasks (id text PRIMARY KEY, agent_id text);
      CREATE TABLE goat.workflow_event_runs (
        id text PRIMARY KEY, workflow_id text REFERENCES goat.workflows(id), trigger_id text NOT NULL DEFAULT 'legacy', workspace_id text, user_workos_id text,
        workflow_slug text, workflow_name text, provider text, event_type text, delivery_id text, goal text, harness_spec jsonb, event_at timestamptz,
        task_id text REFERENCES goat.tasks(id), status text DEFAULT 'pending', attempt_count int DEFAULT 0,
        next_attempt_at timestamptz DEFAULT now(), last_error text,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE (workflow_id, trigger_id, provider, delivery_id)
      );
    `);
  }, 30_000);
  afterAll(() => database.close());
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(async () => {
    vi.clearAllMocks();
    dependencies.getDb.mockReturnValue(db);
    dependencies.loadCredential.mockResolvedValue({ payload: { apiKey: "grn_test" } });
    noteUpdatedAt = new Date(Date.now() - 60_000);
    await database.exec(`
      TRUNCATE goat.workflow_event_runs, goat.tasks, goat.workflows, goat.plugins, goat.integrations,
        goat.workspace_members, goat.users, goat.granola_sync_state CASCADE;
      INSERT INTO goat.users VALUES ('user_1', now());
      INSERT INTO goat.workspace_members VALUES ('workspace_1', 'user_1');
      INSERT INTO goat.integrations VALUES
        ('connection_1', 'granola', NULL, 'user_1', 'connected', 'granola:user_1'),
        ('mcp_connection', 'granola', NULL, 'user_1', 'connected', 'granola_mcp');
      INSERT INTO goat.plugins VALUES ('workspace_1', 'user_1', 'granola', 'enabled', NULL,
        '[{"id":"meeting.notes_ready","filters":[{"id":"folder","kind":"integration_resource","resourceType":"folder","required":false}]}]',
        '{"meeting.notes_ready":true}');
      INSERT INTO goat.workflows VALUES ('workflow_1', 'workspace_1', 'meeting-follow-up', 'Meeting follow-up', 'event', 'active', NULL, 'user_1',
        '{"type":"event","provider":"granola","event":"meeting.notes_ready","integrationId":"connection_1","filters":{},"prompt":"List the decisions and next actions."}', '{}', now() - interval '2 minutes');
      INSERT INTO goat.granola_sync_state (integration_id, user_workos_id, updated_after_cursor)
        VALUES ('connection_1', 'user_1', now() - interval '3 minutes');
    `);
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/notes") {
        return Response.json({
          notes: [
            { id: "note_1", title: "Customer review", updated_at: noteUpdatedAt.toISOString() },
          ],
          hasMore: false,
          cursor: null,
        });
      }
      if (url.pathname === "/v1/notes/note_1") {
        if (url.searchParams.has("include")) {
          return Response.json({ error: { code: "TRANSCRIPT_TOO_LARGE" } }, { status: 413 });
        }
        return Response.json({
          id: "note_1",
          title: "Customer review",
          updated_at: noteUpdatedAt.toISOString(),
          summary_markdown: "Ada will send the proposal on Friday.",
          attendees: [{ name: "Ada", email: "ada@example.com" }],
          folder_membership: [{ id: "fol_acme", parent_folder_id: "fol_customers" }],
          web_url: "https://app.granola.ai/notes/note_1",
          transcript: null,
        });
      }
      if (url.pathname === "/v1/folders") {
        return Response.json({
          folders: [
            { id: "fol_customers", name: "Customers", parent_folder_id: null },
            { id: "fol_acme", name: "Acme", parent_folder_id: "fol_customers" },
          ],
          hasMore: false,
          cursor: null,
        });
      }
      throw new Error(`Unexpected Granola request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  async function poll() {
    return pollGranolaIntegration({ candidate, signal: new AbortController().signal });
  }

  async function allowNextPoll() {
    await database.exec("UPDATE goat.granola_sync_state SET last_polled_at = NULL");
  }

  it("starts one task from a finished summary without downloading the transcript", async () => {
    expect(await listGranolaPollCandidates(db as never)).toEqual([candidate]);
    expect(await poll()).toEqual({ seen: 1, workflowRuns: 1 });
    expect(dependencies.loadCredential).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "connection_1", kind: "api_key" }),
    );
    const createTask = vi.fn(
      async (tx: { execute: (query: ReturnType<typeof sql>) => unknown }) => {
        await tx.execute(sql`INSERT INTO goat.tasks VALUES ('task_1')`);
        return { taskId: "task_1" };
      },
    );
    expect(
      await createNextWorkflowEventTask(new Date(), { db: db as never, createTask }),
    ).toMatchObject({ status: "created", taskId: "task_1" });
    const [delivery] = (
      await database.query<{ goal: string; delivery_id: string }>(
        "SELECT goal, delivery_id FROM goat.workflow_event_runs",
      )
    ).rows;
    expect(delivery?.delivery_id).toBe("note:note_1");
    expect(delivery?.goal).toContain("List the decisions and next actions.");
    expect(delivery?.goal).toContain("Ada will send the proposal on Friday.");

    // A later edit changes updated_at but must not turn the same meeting into another task.
    noteUpdatedAt = new Date();
    await allowNextPoll();
    expect(await poll()).toMatchObject({ workflowRuns: 0 });
    expect(await createNextWorkflowEventTask(new Date(), { db: db as never, createTask })).toEqual({
      status: "none",
    });
    expect(createTask).toHaveBeenCalledOnce();
  });

  it("matches a parent folder through the shared declaration and filter path", async () => {
    await database.exec(`UPDATE goat.workflows SET event_config = jsonb_set(event_config,
      '{filters}', '{"folder":{"id":"fol_customers"}}')`);
    expect(await poll()).toMatchObject({ workflowRuns: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/v1/folders?"),
      expect.anything(),
    );
  });

  it("excludes notes from before activation", async () => {
    noteUpdatedAt = new Date(Date.now() - 150_000);
    expect(await poll()).toMatchObject({ seen: 1, workflowRuns: 0 });
    expect((await database.query("SELECT * FROM goat.workflow_event_runs")).rows).toEqual([]);
  });

  it.each([
    "UPDATE goat.plugins SET event_modes = '{}'",
    "UPDATE goat.plugins SET events = '[]'",
    "UPDATE goat.plugins SET status = 'disabled'",
    "UPDATE goat.plugins SET owner_user_id = 'someone_else'",
    "UPDATE goat.workflows SET status = 'draft'",
    "UPDATE goat.integrations SET status = 'disconnected'",
    "UPDATE goat.workflows SET event_config = jsonb_set(event_config, '{integrationId}', '\"mcp_connection\"')",
    "DELETE FROM goat.workspace_members",
  ])("stops event-only polling when the subscription is unavailable: %s", async (mutation) => {
    await database.exec(mutation);
    expect(await listGranolaPollCandidates(db as never)).toEqual([]);
  });

  it("reauthorizes a queued Granola event before creating its task", async () => {
    await poll();
    await database.exec("UPDATE goat.plugins SET event_modes = '{}'");
    const createTask = vi.fn();
    expect(
      await createNextWorkflowEventTask(new Date(), { db: db as never, createTask }),
    ).toMatchObject({ status: "ignored" });
    expect(createTask).not.toHaveBeenCalled();
  });
});
