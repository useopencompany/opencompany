import {
  TASK_GOAL_MAX_LENGTH,
  TASK_WRITE_PERMISSION,
  TaskApplicationService,
} from "@opencompany/core";
import { disconnectSentry, getSentryConnection } from "@opencompany/db/sentry";
import { snapshotSentryTestSchema } from "@opencompany/db/test-sentry-schema";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { processNextSentryReceipt, selectOccurrence } from "./sentry-event-worker";
import { createNextWorkflowEventTask } from "./workflow-event-worker";

vi.mock("@opencompany/agent/integrations/expiring-oauth-access-token", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getExpiringOAuthAccessToken: vi.fn(async () => "fixture-token"),
}));
let restore: Awaited<ReturnType<typeof snapshotSentryTestSchema>>;
beforeAll(async () => {
  restore = await snapshotSentryTestSchema();
}, 30_000);
afterEach(() => vi.unstubAllGlobals());
const now = new Date("2026-10-03T12:00:00Z");
const installationId = "a8e5d37a-696c-4c54-adb5-b3f28d64c7de";
const filters = {
  project: { id: "1", name: "Web" },
  environment: { id: "production", name: "Production" },
};
async function fixture() {
  const database = await restore();
  const db = drizzle(database);
  await database.exec(`
    INSERT INTO goat.users VALUES ('user_1', now());
    INSERT INTO goat.workspaces VALUES ('workspace_1');
    INSERT INTO goat.workspace_members VALUES ('workspace_1','user_1');
    INSERT INTO goat.integrations (id,provider,workspace_id,user_workos_id,status,external_id) VALUES ('connection_1','sentry','workspace_1','user_1','connected','${installationId}');
    INSERT INTO goat.sentry_connections (integration_id,workspace_id,installation_id,organization_id,organization_slug,region,selected_project_ids,verified_at) VALUES ('connection_1','workspace_1','${installationId}','123','acme','us','["1"]',now());
    INSERT INTO goat.workflows (id,workspace_id,slug,name,trigger,status) VALUES ('workflow_1','workspace_1','investigate','Investigate','event','active');
  `);
  const trigger = {
    id: "trigger_1",
    type: "event",
    provider: "sentry",
    event: "issue.created",
    integrationId: "connection_1",
    filters,
    prompt: "Investigate",
    userWorkosId: "user_1",
    harnessSpec: {},
    activatedAt: "2026-10-03T10:00:00Z",
  };
  await db.execute(
    sql`UPDATE goat.workflows SET automation_triggers = ${JSON.stringify([trigger])}::jsonb`,
  );
  async function enqueue(id: string, issueId = "42", event = "issue.created", eventAt = now) {
    if (event === "issue.regressed")
      await db.execute(
        sql`UPDATE goat.workflows SET automation_triggers = ${JSON.stringify([{ ...trigger, event }])}::jsonb`,
      );
    await db.execute(
      sql`INSERT INTO goat.sentry_webhook_receipts (id,installation_id,resource,payload,event_at) VALUES (${id},${installationId},'issue','{}',${eventAt}) ON CONFLICT DO NOTHING`,
    );
    await db.execute(
      sql`INSERT INTO goat.workflow_event_runs (id,workflow_id,trigger_id,workspace_id,user_workos_id,workflow_slug,workflow_name,provider,event_type,delivery_id,goal,harness_spec,event_at,next_attempt_at) VALUES (${id},'workflow_1','trigger_1','workspace_1','user_1','investigate','Investigate','sentry',${event},${id},'Investigate','{}',${eventAt},${now}) ON CONFLICT DO NOTHING`,
    );
    await db.execute(
      sql`INSERT INTO goat.sentry_issue_runs (event_run_id,receipt_id,integration_id,workspace_id,workflow_id,issue_id,project_id,trigger_filters) VALUES (${id},${id},'connection_1','workspace_1','workflow_1',${issueId},'1',${JSON.stringify(filters)}::jsonb) ON CONFLICT DO NOTHING`,
    );
  }
  // The schema has no Task tables, so the repository records a bare row. Task validation, including
  // the goal limit, is the real service's.
  const createTask = vi.fn(
    async (tx: { execute: typeof db.execute }, event: { id: string; goal: string }) => {
      const taskId = `task_${event.id}`;
      await new TaskApplicationService({
        async createTaskAndRun() {
          await tx.execute(sql`INSERT INTO goat.tasks(id) VALUES (${taskId})`);
          return { task: { id: taskId } };
        },
      } as never).createTask(
        {
          userId: "user_1",
          workspaceId: "workspace_1",
          role: "member",
          permissions: [TASK_WRITE_PERMISSION],
          authenticationMethod: "service",
        },
        {
          idempotencyKey: `workflow-event:${event.id}`,
          goal: event.goal,
          engine: "opencompany",
          model: "fixture-model",
          source: "workflow",
        },
      );
      return { taskId };
    },
  );
  const next = (date = now) =>
    createNextWorkflowEventTask(date, { db: db as never, createTask: createTask as never });
  async function reason(id: string) {
    return (
      await database.query<{ last_error: string }>(
        "SELECT last_error FROM goat.workflow_event_runs WHERE id = $1",
        [id],
      )
    ).rows[0]?.last_error;
  }
  return { database, db, enqueue, next, createTask, reason };
}
it("deduplicates deliveries and prevents overlapping active Tasks for one workflow and issue", async () => {
  const f = await fixture();
  try {
    await f.enqueue("a");
    await f.enqueue("a");
    await f.enqueue("b");
    expect(await f.next()).toMatchObject({ status: "created" });
    expect(await f.next()).toMatchObject({ status: "ignored" });
    expect(await f.reason("b")).toBe("active investigation");
    expect(f.createTask).toHaveBeenCalledOnce();
    expect(
      (await f.database.query("SELECT * FROM goat.sentry_issue_runs WHERE started_at IS NOT NULL"))
        .rows,
    ).toHaveLength(1);
  } finally {
    await f.database.close();
  }
});
it("applies cooldown from started runs while later regressions bypass it", async () => {
  const f = await fixture();
  try {
    await f.enqueue("a");
    await f.next();
    await f.database.exec("UPDATE goat.tasks SET status='succeeded'");
    await f.enqueue("b");
    expect(await f.next()).toMatchObject({ status: "ignored" });
    expect(await f.reason("b")).toBe("cooldown");
    await f.enqueue("c", "42", "issue.regressed");
    expect(await f.next()).toMatchObject({ status: "created" });
  } finally {
    await f.database.close();
  }
});
it("enforces the daily cap across competing deliveries and resets at UTC midnight", async () => {
  const f = await fixture();
  try {
    await f.database.exec("UPDATE goat.sentry_connections SET daily_cap=1");
    await f.enqueue("a", "42");
    await f.enqueue("b", "43");
    const results = await Promise.all([f.next(), f.next()]);
    expect(results.map((result) => result.status).sort()).toEqual(["created", "ignored"]);
    expect((await f.database.query("SELECT count(*)::int AS count FROM goat.tasks")).rows).toEqual([
      { count: 1 },
    ]);
    await f.enqueue("c", "44");
    expect(await f.next(new Date("2026-10-04T00:00:00Z"))).toMatchObject({ status: "created" });
  } finally {
    await f.database.close();
  }
});
it.each(["connection", "project", "member", "workflow", "activation", "conditions"])(
  "revokes queued delivery after %s changes",
  async (change) => {
    const f = await fixture();
    try {
      await f.enqueue("a");
      const changes: Record<string, string> = {
        connection: "UPDATE goat.integrations SET status='disconnected'",
        project: "UPDATE goat.sentry_connections SET selected_project_ids='[]'",
        member: "DELETE FROM goat.workspace_members",
        workflow: "UPDATE goat.workflows SET status='draft'",
        activation:
          "UPDATE goat.workflows SET automation_triggers=jsonb_set(automation_triggers,'{0,activatedAt}','\"2026-10-04T00:00:00Z\"')",
        conditions:
          "UPDATE goat.workflows SET automation_triggers=jsonb_set(automation_triggers,'{0,filters,environment,id}','\"staging\"')",
      };
      await f.database.exec(changes[change]!);
      expect(await f.next()).toMatchObject({ status: "ignored" });
      expect(f.createTask).not.toHaveBeenCalled();
    } finally {
      await f.database.close();
    }
  },
);
it("uninstall revokes pending deliveries while retaining completed Task history", async () => {
  const f = await fixture();
  try {
    await f.enqueue("a");
    await f.next();
    await f.enqueue("b", "43");
    await disconnectSentry(installationId, f.db);
    expect(await f.next()).toMatchObject({ status: "ignored" });
    expect(await f.reason("b")).toBe("disconnected account");
    expect((await f.database.query("SELECT id FROM goat.tasks")).rows).toEqual([{ id: "task_a" }]);
  } finally {
    await f.database.close();
  }
});
it("routes from persisted evidence without refetching on retries and does not mix environments", async () => {
  const f = await fixture();
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Persisted evidence must not be refetched");
      }),
    );
    const issue = { id: "42", title: "Error", priority: "high", project: { id: "1", slug: "web" } };
    const envelope = {
      action: "created",
      installation: { uuid: installationId },
      data: { issue: { ...issue, issueCategory: "error" } },
    };
    const evidence = {
      issue,
      eventType: "issue.created",
      occurrence: {
        eventID: "a".repeat(32),
        dateCreated: "2026-10-03T11:00:00Z",
        environment: "staging",
      },
      unavailableReason: null,
    };
    await f.db.execute(
      sql`INSERT INTO goat.sentry_webhook_receipts(id,installation_id,resource,payload,event_at,next_attempt_at,evidence) VALUES ('receipt',${installationId},'issue',${JSON.stringify(envelope)}::jsonb,${now},${now},${JSON.stringify(evidence)}::jsonb)`,
    );
    expect(await processNextSentryReceipt(now, f.db)).toBe(true);
    expect(
      (
        await f.database.query(
          "SELECT status,reason FROM goat.sentry_webhook_receipts WHERE id='receipt'",
        )
      ).rows,
    ).toEqual([{ status: "ignored", reason: "conditions not matched: environment" }]);
    expect((await f.database.query("SELECT * FROM goat.workflow_event_runs")).rows).toEqual([]);
    evidence.occurrence.environment = "production";
    await f.db.execute(
      sql`UPDATE goat.sentry_webhook_receipts SET status='pending', evidence=${JSON.stringify(evidence)}::jsonb WHERE id='receipt'`,
    );
    expect(await processNextSentryReceipt(now, f.db)).toBe(true);
    expect(
      (
        await f.database.query(
          "SELECT status,reason FROM goat.sentry_webhook_receipts WHERE id='receipt'",
        )
      ).rows,
    ).toEqual([{ status: "processed", reason: "routed 1 workflow deliveries" }]);
    expect(await f.next(new Date())).toMatchObject({ status: "created" });
  } finally {
    await f.database.close();
  }
});

it("fits a maximal prompt, occurrence data and prior results into one accepted Task goal", async () => {
  const f = await fixture();
  try {
    await f.database.exec("UPDATE goat.sentry_connections SET cooldown_minutes=0");
    await f.enqueue("prior");
    expect(await f.next()).toMatchObject({ status: "created" });
    await f.db.execute(
      sql`UPDATE goat.tasks SET status='succeeded', result=${"r".repeat(5_000)}, session_id='session_prior' WHERE id='task_prior'`,
    );
    await f.database.exec(
      "INSERT INTO goat.session_pull_requests VALUES ('https://github.com/acme/web/pull/7','session_prior')",
    );
    await f.database.exec(
      `UPDATE goat.workflows SET automation_triggers=jsonb_set(automation_triggers,'{0,prompt}','"${"p".repeat(8_000)}"')`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Persisted evidence must not be refetched");
      }),
    );
    const issue = { id: "42", title: "Error", project: { id: "1", slug: "web" } };
    const evidence = {
      issue,
      eventType: "issue.created",
      occurrence: {
        eventID: "a".repeat(32),
        dateCreated: "2026-10-03T11:00:00Z",
        environment: "production",
        message: "m".repeat(2_000),
        breadcrumbs: Array.from({ length: 10 }, () => "b".repeat(2_000)),
      },
      unavailableReason: null,
    };
    await f.db.execute(
      sql`INSERT INTO goat.sentry_webhook_receipts(id,installation_id,resource,payload,event_at,next_attempt_at,evidence) VALUES ('receipt',${installationId},'issue',${JSON.stringify({ action: "created", installation: { uuid: installationId }, data: { issue: { ...issue, issueCategory: "error" } } })}::jsonb,${now},${now},${JSON.stringify(evidence)}::jsonb)`,
    );
    expect(await processNextSentryReceipt(now, f.db)).toBe(true);

    expect(await f.next(new Date())).toMatchObject({ status: "created" });
    const goal = f.createTask.mock.calls.at(-1)![1].goal;
    expect(goal.length).toBeLessThanOrEqual(TASK_GOAL_MAX_LENGTH);
    expect(goal).toContain("</sentry_event_data>");
    expect(goal).toContain("https://github.com/acme/web/pull/7");
    expect(goal.endsWith("</sentry_prior_task_data>")).toBe(true);
  } finally {
    await f.database.close();
  }
});

it("selects first-occurrence evidence and refuses a later surviving production event", async () => {
  const f = await fixture();
  try {
    const connection = (await getSentryConnection("workspace_1", f.db))!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        expect(url.pathname).toBe("/api/0/organizations/acme/issues/42/events/oldest/");
        return Response.json({
          eventID: "a".repeat(32),
          dateCreated: "2026-10-03T11:00:00Z",
          environment: "staging",
        });
      }),
    );
    await expect(
      selectOccurrence(connection, "42", "issue.created", now, null, "2026-10-03T11:00:00Z", f.db),
    ).resolves.toMatchObject({ occurrence: { environment: "staging" }, unavailableReason: null });
    await expect(
      selectOccurrence(connection, "42", "issue.created", now, null, "2026-10-03T10:00:00Z", f.db),
    ).resolves.toEqual({
      occurrence: null,
      unavailableReason: "first occurrence context unavailable",
    });
  } finally {
    await f.database.close();
  }
});
it("selects regression evidence before the notification, excluding newer occurrences", async () => {
  const f = await fixture();
  try {
    const connection = (await getSentryConnection("workspace_1", f.db))!;
    const id = "b".repeat(32);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (url.pathname.endsWith("/events/")) {
          expect(url.searchParams.get("end")).toBe(now.toISOString());
          return Response.json([
            { eventID: "a".repeat(32), dateCreated: "2026-10-03T12:01:00Z" },
            { eventID: id, dateCreated: "2026-10-03T11:59:00Z" },
            { eventID: "c".repeat(32), dateCreated: "2026-10-03T11:58:00Z" },
          ]);
        }
        expect(url.pathname).toContain(`/events/${id}/`);
        return Response.json({
          eventID: id,
          dateCreated: "2026-10-03T11:59:00Z",
          environment: "production",
        });
      }),
    );
    await expect(
      selectOccurrence(connection, "42", "issue.regressed", now, null, undefined, f.db),
    ).resolves.toMatchObject({ occurrence: { eventID: id }, unavailableReason: null });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    await f.database.close();
  }
});
it("retries transient enrichment and records unavailable context instead of starting a Task", async () => {
  const f = await fixture();
  try {
    const issue = {
      id: "42",
      title: "Error",
      project: { id: "1", slug: "web" },
      firstSeen: "2026-10-03T11:00:00Z",
      issueCategory: "error",
    };
    const envelope = { action: "created", installation: { uuid: installationId }, data: { issue } };
    await f.db.execute(
      sql`INSERT INTO goat.sentry_webhook_receipts(id,installation_id,resource,payload,event_at,next_attempt_at) VALUES ('retry',${installationId},'issue',${JSON.stringify(envelope)}::jsonb,${now},${now})`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await processNextSentryReceipt(now, f.db);
    expect(
      (
        await f.database.query(
          "SELECT status,attempts FROM goat.sentry_webhook_receipts WHERE id='retry'",
        )
      ).rows,
    ).toEqual([{ status: "pending", attempts: 1 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname.endsWith("/events/oldest/")
          ? new Response(null, { status: 404 })
          : Response.json(issue),
      ),
    );
    await processNextSentryReceipt(new Date(now.getTime() + 5000), f.db);
    expect(
      (
        await f.database.query(
          "SELECT status,reason FROM goat.sentry_webhook_receipts WHERE id='retry'",
        )
      ).rows,
    ).toEqual([{ status: "ignored", reason: "occurrence context unavailable" }]);
    expect(f.createTask).not.toHaveBeenCalled();
  } finally {
    await f.database.close();
  }
});
it("rejects an alert destination that does not match an eligible shared trigger", async () => {
  const f = await fixture();
  try {
    const issue = { id: "42", title: "Error", project: { id: "1", slug: "web" } };
    const occurrence = { eventID: "a".repeat(32), dateCreated: "2026-10-03T11:00:00Z" };
    const envelope = {
      action: "triggered",
      installation: { uuid: installationId },
      data: {
        event: { issue_id: "42" },
        issue_alert: {
          settings: [
            {
              name: "destination",
              value: JSON.stringify({ workflowId: "workflow_1", triggerId: "foreign" }),
            },
          ],
        },
      },
    };
    await f.db.execute(
      sql`INSERT INTO goat.sentry_webhook_receipts(id,installation_id,resource,payload,event_at,next_attempt_at,evidence) VALUES ('alert',${installationId},'event_alert',${JSON.stringify(envelope)}::jsonb,${now},${now},${JSON.stringify({ issue, occurrence, eventType: "issue_alert.triggered", unavailableReason: null })}::jsonb)`,
    );
    await processNextSentryReceipt(now, f.db);
    expect(
      (
        await f.database.query(
          "SELECT status,reason FROM goat.sentry_webhook_receipts WHERE id='alert'",
        )
      ).rows,
    ).toEqual([{ status: "ignored", reason: "invalid alert-action destination" }]);
    expect(f.createTask).not.toHaveBeenCalled();
  } finally {
    await f.database.close();
  }
});

it("keeps queued deliveries revoked after reconnecting the same installation", async () => {
  const f = await fixture();
  try {
    await f.enqueue("old");
    await disconnectSentry(installationId, f.db);
    await f.database.exec("UPDATE goat.integrations SET status='connected'");
    expect(await f.next()).toMatchObject({ status: "ignored" });
    expect(await f.reason("old")).toBe("delivery revoked by disconnection");
    expect(f.createTask).not.toHaveBeenCalled();
  } finally {
    await f.database.close();
  }
});

it("pins the regression event before a transient details failure and reuses it on retry", async () => {
  const f = await fixture();
  try {
    await f.enqueue("setup", "42", "issue.regressed");
    await f.database.exec(
      "DELETE FROM goat.sentry_issue_runs; DELETE FROM goat.workflow_event_runs; DELETE FROM goat.sentry_webhook_receipts",
    );
    const issue = {
      id: "42",
      title: "Error",
      project: { id: "1", slug: "web" },
      substatus: "regressed",
    };
    const envelope = {
      action: "unresolved",
      installation: { uuid: installationId },
      data: { issue },
    };
    await f.db.execute(
      sql`INSERT INTO goat.sentry_webhook_receipts(id,installation_id,resource,payload,event_at,next_attempt_at) VALUES ('pinned',${installationId},'issue',${JSON.stringify(envelope)}::jsonb,${now},${now})`,
    );
    const id = "b".repeat(32);
    let detailsAttempts = 0;
    let listAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (url.pathname.endsWith("/events/")) {
          listAttempts++;
          return Response.json([
            {
              eventID: listAttempts === 1 ? id : "c".repeat(32),
              dateCreated: "2026-10-03T11:59:00Z",
            },
          ]);
        }
        if (url.pathname.includes("/events/")) {
          expect(url.pathname).toContain(`/events/${id}/`);
          detailsAttempts++;
          return detailsAttempts === 1
            ? new Response(null, { status: 503 })
            : Response.json({
                eventID: id,
                dateCreated: "2026-10-03T11:59:00Z",
                environment: "production",
              });
        }
        return Response.json(issue);
      }),
    );
    await processNextSentryReceipt(now, f.db);
    expect(
      (
        await f.database.query(
          "SELECT selected_event_id,status,evidence FROM goat.sentry_webhook_receipts WHERE id='pinned'",
        )
      ).rows,
    ).toEqual([{ selected_event_id: id, status: "pending", evidence: null }]);
    await processNextSentryReceipt(new Date(now.getTime() + 5000), f.db);
    expect(listAttempts).toBe(1);
    expect(detailsAttempts).toBe(2);
    expect(
      (
        await f.database.query<{ evidence: { occurrence: { eventID: string } }; status: string }>(
          "SELECT evidence,status FROM goat.sentry_webhook_receipts WHERE id='pinned'",
        )
      ).rows[0],
    ).toMatchObject({ evidence: { occurrence: { eventID: id } }, status: "processed" });
  } finally {
    await f.database.close();
  }
});
