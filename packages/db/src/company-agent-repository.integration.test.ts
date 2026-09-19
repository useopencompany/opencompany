import { PGlite } from "@electric-sql/pglite";
import { type Actor, WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION } from "@opencompany/core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresWorkflowRepository } from "./workflow-repository";

// Workflows and Company agents share one table, so the isolation between them is a SQL predicate
// rather than a convention a caller can forget. These tests exercise that predicate directly:
// whatever the application layer does, an agent must be unreachable through a workflow-kind
// repository and a workflow unreachable through an agent-kind one.
const dialect = new PgDialect();
const now = new Date("2026-09-18T08:00:00.000Z");

describe("Company agent rows in the shared automation table", () => {
  let database: PGlite;
  let workflowRepository: PostgresWorkflowRepository;
  let agentRepository: PostgresWorkflowRepository;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(SCHEMA);
    const execute = (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      return database.query(sql, params as unknown[]);
    };
    workflowRepository = new PostgresWorkflowRepository(execute, { now: () => now });
    agentRepository = new PostgresWorkflowRepository(execute, { now: () => now, kind: "agent" });
  });

  it("keeps each surface blind to the other's rows", async () => {
    const workflow = await workflowRepository.createWorkflow({
      actor: actor(),
      idempotencyKey: "create-workflow",
      name: "Weekly research",
      description: "",
      scope: "company",
      initialStep: step(),
    });
    const agent = await agentRepository.createWorkflow({
      actor: actor(),
      idempotencyKey: "create-agent",
      name: "PR Reviewer",
      description: "",
      scope: "company",
      initialStep: step(),
    });

    expect(workflow.workflow.kind).toBe("workflow");
    expect(agent.workflow.kind).toBe("agent");
    expect(agent.workflow.slackChannel.enabled).toBe(false);
    expect(workflow.workflow.slackChannel.enabled).toBe(true);

    // Lists never cross over.
    await expect(
      workflowRepository.listWorkflows({ actor: actor(), limit: 50 }),
    ).resolves.toMatchObject({ workflows: [{ id: workflow.workflow.id }] });
    await expect(
      agentRepository.listWorkflows({ actor: actor(), limit: 50 }),
    ).resolves.toMatchObject({ workflows: [{ id: agent.workflow.id }] });

    // Nor do direct reads, which is what protects the agents API from a workflow id and, more
    // importantly, the Workflows API from an agent id whose writes are owner-only.
    await expect(
      workflowRepository.getWorkflow({ actor: actor(), workflowId: agent.workflow.id }),
    ).resolves.toBeNull();
    await expect(
      agentRepository.getWorkflow({ actor: actor(), workflowId: workflow.workflow.id }),
    ).resolves.toBeNull();
  });

  it("records the creator as the owner of an agent and leaves workflows ownerless", async () => {
    const agent = await agentRepository.createWorkflow({
      actor: actor(),
      idempotencyKey: "create-agent",
      name: "PR Reviewer",
      description: "",
      scope: "company",
      initialStep: step(),
    });
    const workflow = await workflowRepository.createWorkflow({
      actor: actor(),
      idempotencyKey: "create-workflow",
      name: "Weekly research",
      description: "",
      scope: "company",
      initialStep: step(),
    });

    expect(agent.workflow).toMatchObject({ ownerUserId: "user_owner", ownerActive: true });
    expect(workflow.workflow).toMatchObject({ ownerUserId: null, ownerActive: false });
  });

  it("reads an agent as ownerless once the owner leaves the workspace", async () => {
    const agent = await agentRepository.createWorkflow({
      actor: actor(),
      idempotencyKey: "create-agent",
      name: "PR Reviewer",
      description: "",
      scope: "company",
      initialStep: step(),
    });
    await database.exec("DELETE FROM goat.workspace_members WHERE user_workos_id = 'user_owner'");

    // The row still names an owner; what changed is that they can no longer authorize anything.
    await expect(
      agentRepository.getWorkflow({
        actor: actor({ userId: "user_mate" }),
        workflowId: agent.workflow.id,
      }),
    ).resolves.toMatchObject({ ownerUserId: "user_owner", ownerActive: false });
  });

  it("reports both completed work and events that were blocked before any work started", async () => {
    const agent = await agentRepository.createWorkflow({
      actor: actor(),
      idempotencyKey: "create-agent",
      name: "PR Reviewer",
      description: "",
      scope: "company",
      initialStep: step(),
    });
    await database.query(
      `INSERT INTO goat.tasks (id, display_id, name, session_id, status, archived_at, agent_id, result, error, created_at, updated_at)
       VALUES ('task_1', 'TASK-1', 'PR Reviewer', 'conversation_1', 'succeeded', NULL, $1, 'Posted findings.', NULL, $2, $2)`,
      [agent.workflow.id, now],
    );
    await database.query(
      `INSERT INTO goat.workflow_event_runs (id, workflow_id, provider, event_type, task_id, status, last_error, created_at, updated_at)
       VALUES ('event_1', $1, 'github', 'pull_request.opened', NULL, 'ignored', NULL, $2, $2)`,
      [agent.workflow.id, new Date("2026-09-18T07:00:00.000Z")],
    );

    const runs = await agentRepository.listRuns({
      actor: actor({ userId: "user_mate" }),
      workflowId: agent.workflow.id,
      limit: 50,
    });

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      taskId: "task_1",
      displayId: "TASK-1",
      status: "succeeded",
      triggerKind: "manual",
      triggerLabel: "Run now",
      result: "Posted findings.",
    });
    // A dropped event is the failure mode this view exists for, so it carries a reason rather
    // than simply being absent.
    expect(runs[1]).toMatchObject({
      taskId: null,
      status: "blocked",
      triggerKind: "event",
      triggerLabel: "github · pull_request.opened",
    });
    expect(runs[1]?.error).toContain("github");
  });

  it("returns no runs for an agent in another workspace", async () => {
    const agent = await agentRepository.createWorkflow({
      actor: actor(),
      idempotencyKey: "create-agent",
      name: "PR Reviewer",
      description: "",
      scope: "company",
      initialStep: step(),
    });

    await expect(
      agentRepository.listRuns({
        actor: actor({ userId: "user_outsider", workspaceId: "workspace_other" }),
        workflowId: agent.workflow.id,
        limit: 50,
      }),
    ).resolves.toEqual([]);
  });
});

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_owner",
    workspaceId: "workspace_1",
    role: "member",
    permissions: [WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION],
    authenticationMethod: "session",
    ...overrides,
  };
}

function step() {
  return { id: "step_1", title: "", model: "provider/model", instructions: "Review the diff." };
}

// The narrowest schema the shared repository queries touch, plus the two helper functions the run
// history calls. Column definitions mirror `product-schema.ts` and migration 0302.
const SCHEMA = `
  CREATE SCHEMA goat;
  CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
  CREATE TABLE goat.workspaces (id text PRIMARY KEY);
  CREATE TABLE goat.workspace_members (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    user_workos_id text NOT NULL,
    role text NOT NULL
  );
  CREATE TABLE goat.workflows (
    id text PRIMARY KEY,
    workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
    slug text NOT NULL,
    kind text NOT NULL DEFAULT 'workflow',
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    instructions text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    trigger text NOT NULL DEFAULT 'manual',
    automation_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
    schedule_cron text,
    schedule_timezone text NOT NULL DEFAULT 'UTC',
    schedule_prompt text NOT NULL DEFAULT '',
    schedule_user_workos_id text REFERENCES goat.users(workos_user_id) ON DELETE SET NULL,
    schedule_harness_spec jsonb,
    schedule_enabled boolean NOT NULL DEFAULT false,
    schedule_last_run_at timestamptz,
    schedule_next_run_at timestamptz,
    event_activated_at timestamptz,
    event_config jsonb,
    event_user_workos_id text REFERENCES goat.users(workos_user_id) ON DELETE SET NULL,
    event_harness_spec jsonb,
    status text NOT NULL DEFAULT 'active',
    scope text NOT NULL DEFAULT 'company',
    slack_channel_enabled boolean NOT NULL DEFAULT true,
    slack_bot_display_name text NOT NULL DEFAULT '',
    slack_bot_avatar_url text NOT NULL DEFAULT '',
    created_by_workos_id text REFERENCES goat.users(workos_user_id) ON DELETE SET NULL,
    owner_workos_id text REFERENCES goat.users(workos_user_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    version integer NOT NULL DEFAULT 1,
    CONSTRAINT opencompany_workflows_kind_check CHECK (kind IN ('workflow', 'agent'))
  );
  CREATE UNIQUE INDEX goat_workflows_workspace_slug_idx
    ON goat.workflows(workspace_id, slug) WHERE archived_at IS NULL;
  CREATE TABLE goat.tasks (
    id text PRIMARY KEY,
    display_id text NOT NULL,
    name text NOT NULL,
    session_id text,
    status text NOT NULL,
    archived_at timestamptz,
    agent_id text REFERENCES goat.workflows(id) ON DELETE SET NULL,
    result text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.workflow_schedule_runs (
    id text PRIMARY KEY,
    workflow_id text NOT NULL REFERENCES goat.workflows(id) ON DELETE CASCADE,
    trigger_id text NOT NULL DEFAULT 'legacy',
    workspace_id text,
    user_workos_id text,
    scheduled_for timestamptz NOT NULL,
    task_id text REFERENCES goat.tasks(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workflow_id, trigger_id, scheduled_for)
  );
  CREATE TABLE goat.workflow_event_runs (
    id text PRIMARY KEY,
    workflow_id text NOT NULL REFERENCES goat.workflows(id) ON DELETE CASCADE,
    provider text NOT NULL,
    event_type text NOT NULL,
    task_id text REFERENCES goat.tasks(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending',
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.workflow_memories (
    workflow_id text PRIMARY KEY REFERENCES goat.workflows(id) ON DELETE CASCADE,
    workspace_id text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    content text NOT NULL DEFAULT '',
    content_updated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.automation_command_idempotency (
    command_id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    workspace_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    operation text NOT NULL,
    resource_id text,
    transaction_id bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    touched_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_workos_id, workspace_id, idempotency_key)
  );
  CREATE FUNCTION goat.canonical_task_status_v1(status text, archived_at timestamptz)
  RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN archived_at IS NOT NULL THEN 'archived' ELSE status END
  $$;
  CREATE FUNCTION goat.conversation_awaiting_input_v1(conversation_id text)
  RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

  INSERT INTO goat.users (workos_user_id)
    VALUES ('user_owner'), ('user_mate'), ('user_outsider');
  INSERT INTO goat.workspaces (id) VALUES ('workspace_1'), ('workspace_other');
  INSERT INTO goat.workspace_members (id, workspace_id, user_workos_id, role) VALUES
    ('member_1', 'workspace_1', 'user_owner', 'member'),
    ('member_2', 'workspace_1', 'user_mate', 'member'),
    ('member_3', 'workspace_other', 'user_outsider', 'member');
`;
