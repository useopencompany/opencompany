import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { postWorkflowSlackMessage } from "@opencompany/agent/integrations/slack-channel";
import {
  completeChannelDelivery,
  enqueueSlackThreadReply,
  type SubscriptionExecute,
} from "@opencompany/db/session-subscriptions";
import { snapshotPGliteSchema } from "@opencompany/db/test-schema-snapshot";
import { TASK_TEST_BASE_SCHEMA } from "@opencompany/db/test-task-schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  processNextChannelDelivery,
  processNextSubscriptionEvent,
  type SlackChannelWorkerDependencies,
} from "./slack-channel-worker";

vi.mock("@opencompany/db/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadIntegrationCredential: vi.fn(async () => ({
    payload: { access_token: "fixture", bot_user_id: "BOT" },
  })),
}));
vi.mock("@opencompany/agent/integrations/slack", () => ({
  slackApiRequest: vi.fn(async () => ({ channel: { id: "C1", is_member: true } })),
}));

let restore: () => Promise<PGlite>;
let pg: PGlite;
let deps: SlackChannelWorkerDependencies;
const reply = {
  teamId: "T1",
  eventId: "Ev1",
  channelId: "C1",
  threadTs: "100.001",
  messageTs: "100.002",
  slackUserId: "U1",
  text: "What are the DB implications?",
};
const dialect = new PgDialect();
let execute: SubscriptionExecute;
beforeAll(async () => {
  restore = await snapshotPGliteSchema(async (db) => {
    await db.exec(TASK_TEST_BASE_SCHEMA);
    for (const name of [
      "0198_goat_headless_chat_foundation",
      "0199_goat_chat_attachment_uploads",
      "0200_goat_chat_run_pausing",
      "0201_goat_chat_read_models_v1",
      "0202_goat_headless_task_foundation",
      "0204_goat_task_conversation_history_projection",
      "0205_goat_task_history_projection_repair",
      "0215_goat_chat_sidebar_state",
      "0216_goat_conversation_runtime_summary",
      "0223_goat_task_projection_preservation",
      "0245_goat_task_activities",
      "0246_goat_task_waiting_status",
      "0248_goat_chat_attachment_upload_idempotency",
    ]) {
      await db.exec(
        await readFile(new URL(`../../../drizzle/${name}.sql`, import.meta.url), "utf8"),
      );
    }
    await db.exec(`ALTER TABLE goat.users ADD COLUMN email text;
      CREATE TABLE goat.integrations (id text PRIMARY KEY, workspace_id text, user_workos_id text, provider text, external_id text, status text, scopes jsonb);
      CREATE TABLE goat.workflows (id text PRIMARY KEY, workspace_id text);
    `);
    await db.exec(
      await readFile(
        new URL("../../../drizzle/0289_workflow_slack_channel.sql", import.meta.url),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL("../../../drizzle/0282_durable_session_subscriptions.sql", import.meta.url),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL("../../../drizzle/0284_slack_thread_participants.sql", import.meta.url),
        "utf8",
      ),
    );
    await db.exec(
      await readFile(
        new URL("../../../drizzle/0290_channel_delivery_bot_identity.sql", import.meta.url),
        "utf8",
      ),
    );
  });
}, 60_000);
beforeEach(async () => {
  pg = await restore();
  execute = (query) => {
    const compiled = dialect.sqlToQuery(query);
    return pg.query(compiled.sql, compiled.params);
  };
  deps = {
    db: drizzle(pg),
    credential: vi.fn(async () => ({ token: "test-token", botUserId: "BOT" })),
    validateChannel: vi.fn(async (_token, id) => id),
    request: vi.fn(async ({ method }: { method: string }) =>
      method === "users.info"
        ? {
            user: {
              id: "U1",
              team_id: "T1",
              profile: { real_name: "Member Person", email: "member@example.com" },
            },
          }
        : {
            messages: [
              { user: "BOT", text: "Investigation result" },
              { user: "U1", text: "What are the DB implications?" },
            ],
          },
    ) as unknown as SlackChannelWorkerDependencies["request"],
  };
  await pg.exec(`
    INSERT INTO goat.users (workos_user_id, email) VALUES ('owner', 'owner@example.com'), ('member', 'member@example.com');
    INSERT INTO goat.workspaces (id) VALUES ('workspace');
    INSERT INTO goat.workspace_members (id, workspace_id, user_workos_id, role) VALUES ('m1', 'workspace', 'member', 'member'), ('m2', 'workspace', 'owner', 'admin');
    INSERT INTO goat.chat_sessions (id, user_workos_id, title, model, engine, kind) VALUES ('session', 'owner', 'Investigation', 'test/model', 'codex', 'task');
    INSERT INTO goat.codex_chat_sessions (id, user_workos_id, chat_session_id, workspace_id, engine, model, status) VALUES ('runtime', 'owner', 'session', 'workspace', 'codex', 'test/model', 'idle');
    INSERT INTO goat.tasks (id, user_workos_id, workspace_id, prompt, model, session_id, source, workflow_id, status, harness_spec, sandbox_id) VALUES ('task', 'owner', 'workspace', 'Investigate the bug', 'test/model', 'session', 'workflow', 'workflow', 'succeeded', '{"engine":"codex","model":"test/model","systemPrompt":"Original workflow instructions","workflow":{"stepIndex":0,"steps":[{"instructions":"Investigate"}]}}', 'saved-sandbox');
    INSERT INTO goat.integrations VALUES ('install', 'workspace', 'owner', 'slack_bot', 'T1', 'connected', '[]');
    INSERT INTO goat.workflows (id, workspace_id, slack_bot_display_name) VALUES ('workflow', 'workspace', 'James');
    INSERT INTO goat.channel_deliveries (id, workspace_id, session_id, integration_id, team_id, channel_id, text, status) VALUES ('root', 'workspace', 'session', 'install', 'T1', 'C1', 'Investigation result', 'sending');
  `);
  await completeChannelDelivery(execute, {
    id: "root",
    teamId: "T1",
    channelId: "C1",
    threadTs: null,
    messageTs: "100.001",
  });
});
afterEach(async () => {
  await pg.close();
});

describe("durable Slack subscriptions", () => {
  it("upgrades existing thread policies without losing the subscription or other settings", async () => {
    await pg.exec(
      `UPDATE goat.session_subscriptions SET policy = '{"authorization":"workspace_member","queue":"serial","custom":true}'`,
    );
    await pg.exec(
      await readFile(
        new URL("../../../drizzle/0284_slack_thread_participants.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      (await pg.query("SELECT id, status, policy FROM goat.session_subscriptions")).rows,
    ).toEqual([
      {
        id: "root",
        status: "waiting",
        policy: { authorization: "slack_thread_participant", queue: "serial", custom: true },
      },
    ]);
  });
  it("persists workflow root intents with a stable key and rejects foreign callers", async () => {
    await pg.exec(`
      UPDATE goat.integrations SET scopes = '["chat:write","channels:read","channels:history","users:read","users:read.email"]';
      INSERT INTO goat.chat_messages (id, session_id, role, content, task_id) VALUES ('initial_user','session','user','Investigate','task'), ('initial_assistant','session','assistant','','task');
      INSERT INTO goat.codex_chat_turns (id,user_workos_id,codex_chat_session_id,chat_session_id,user_message_id,assistant_message_id,status,prompt,lease_id,lease_expires_at)
        VALUES ('initial_run','owner','runtime','session','initial_user','initial_assistant','running','Investigate','lease',now() + interval '1 minute');
    `);
    const input = {
      runId: "initial_run",
      actorId: "owner",
      post: { channel: "C1", text: "Investigation summary", messageKey: "summary" },
    };
    const first = await postWorkflowSlackMessage(input, execute);
    const replay = await postWorkflowSlackMessage(input, execute);
    expect(first.deliveryId).toBe(replay.deliveryId);
    expect(
      (await pg.query("SELECT text FROM goat.channel_deliveries WHERE id <> 'root'")).rows,
    ).toEqual([{ text: "Investigation summary" }]);
    expect((await pg.query("SELECT id FROM goat.channel_deliveries")).rows).toHaveLength(2);
    await expect(
      postWorkflowSlackMessage({ ...input, actorId: "member" }, execute),
    ).rejects.toThrow("active workflow session");
    await expect(
      postWorkflowSlackMessage(
        { ...input, post: { ...input.post, text: "Different content" } },
        execute,
      ),
    ).rejects.toThrow("messageKey");
    expect(
      (await pg.query("SELECT bot_display_name FROM goat.channel_deliveries WHERE id <> 'root'"))
        .rows,
    ).toEqual([{ bot_display_name: "James" }]);
  });
  it("refuses to post for a workflow whose Slack channel is turned off", async () => {
    await pg.exec(`
      UPDATE goat.integrations SET scopes = '["chat:write","channels:read","channels:history","users:read","users:read.email"]';
      UPDATE goat.workflows SET slack_channel_enabled = false;
      INSERT INTO goat.chat_messages (id, session_id, role, content, task_id) VALUES ('initial_user','session','user','Investigate','task'), ('initial_assistant','session','assistant','','task');
      INSERT INTO goat.codex_chat_turns (id,user_workos_id,codex_chat_session_id,chat_session_id,user_message_id,assistant_message_id,status,prompt,lease_id,lease_expires_at)
        VALUES ('initial_run','owner','runtime','session','initial_user','initial_assistant','running','Investigate','lease',now() + interval '1 minute');
    `);
    await expect(
      postWorkflowSlackMessage(
        {
          runId: "initial_run",
          actorId: "owner",
          post: { channel: "C1", text: "Investigation summary", messageKey: "summary" },
        },
        execute,
      ),
    ).rejects.toThrow("Slack channel enabled");
    expect((await pg.query("SELECT id FROM goat.channel_deliveries")).rows).toHaveLength(1);
  });
  it("creates exactly one subscription and deduplicates retries without accepting untracked threads", async () => {
    await completeChannelDelivery(execute, {
      id: "root",
      teamId: "T1",
      channelId: "C1",
      threadTs: null,
      messageTs: "100.001",
    });
    expect(
      (
        await pg.query(
          "SELECT policy->>'authorization' AS authorization FROM goat.session_subscriptions",
        )
      ).rows,
    ).toEqual([{ authorization: "slack_thread_participant" }]);
    expect(await enqueueSlackThreadReply(execute, reply)).toBe(1);
    expect(await enqueueSlackThreadReply(execute, reply)).toBe(0);
    expect(
      await enqueueSlackThreadReply(execute, { ...reply, eventId: "Ev2", threadTs: "other" }),
    ).toBe(0);
  });
  it("resumes the same conversation and environment once, then serializes the next reply until delivery", async () => {
    await enqueueSlackThreadReply(execute, reply);
    await enqueueSlackThreadReply(execute, {
      ...reply,
      eventId: "Ev2",
      messageTs: "100.003",
      text: "And rollout?",
    });
    expect(await processNextSubscriptionEvent(deps)).toBe(true);
    expect(await processNextSubscriptionEvent(deps)).toBe(false);
    const runs = (
      await pg.query<{ id: string; chat_session_id: string; codex_chat_session_id: string }>(
        "SELECT * FROM goat.codex_chat_turns",
      )
    ).rows;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ chat_session_id: "session", codex_chat_session_id: "runtime" });
    expect((await pg.query("SELECT sandbox_id FROM goat.tasks")).rows).toEqual([
      { sandbox_id: "saved-sandbox" },
    ]);
    await pg.exec(
      `UPDATE goat.integrations SET scopes = '["chat:write","channels:read","channels:history","users:read","users:read.email"]';
       UPDATE goat.codex_chat_turns SET status = 'running', lease_id = 'reply-lease', lease_expires_at = now() + interval '1 minute';
       UPDATE goat.codex_chat_sessions SET status = 'running';`,
    );
    const posted = await postWorkflowSlackMessage(
      {
        runId: runs[0]!.id,
        actorId: "owner",
        post: { text: "Additive migration; retained artifacts.", messageKey: "slack-follow-up-1" },
      },
      execute,
    );
    expect(posted.message).toContain("originating Slack thread");
    expect(await processNextSubscriptionEvent(deps)).toBe(false);
    const deliveries = (
      await pg.query(
        "SELECT channel_id, thread_ts, text FROM goat.channel_deliveries WHERE id <> 'root'",
      )
    ).rows;
    expect(deliveries).toEqual([
      { channel_id: "C1", thread_ts: "100.001", text: "Additive migration; retained artifacts." },
    ]);
    await pg.exec("UPDATE goat.channel_deliveries SET status = 'sent' WHERE id <> 'root'");
    expect(await processNextSubscriptionEvent(deps)).toBe(true);
    expect(await processNextSubscriptionEvent(deps)).toBe(false);
    await pg.exec(
      `UPDATE goat.codex_chat_turns SET status = 'completed'; UPDATE goat.codex_chat_sessions SET status = 'idle'; UPDATE goat.tasks SET status = 'succeeded';`,
    );
    expect(await processNextSubscriptionEvent(deps)).toBe(true);
    expect((await pg.query("SELECT id FROM goat.codex_chat_turns")).rows).toHaveLength(2);
    expect((await pg.query("SELECT id FROM goat.tasks")).rows).toHaveLength(1);
  });
  it("does not copy a completed assistant turn into Slack when the reply tool was not used", async () => {
    await enqueueSlackThreadReply(execute, reply);
    await processNextSubscriptionEvent(deps);
    await pg.exec(
      `UPDATE goat.codex_chat_turns SET status = 'completed';
       UPDATE goat.codex_chat_sessions SET status = 'idle';
       UPDATE goat.tasks SET status = 'succeeded';
       UPDATE goat.chat_messages SET content = 'Task-only final answer' WHERE role = 'assistant';`,
    );
    expect(await processNextSubscriptionEvent(deps)).toBe(true);
    expect(
      (await pg.query("SELECT id FROM goat.channel_deliveries WHERE id <> 'root'")).rows,
    ).toEqual([]);
    expect((await pg.query("SELECT status FROM goat.subscription_events")).rows).toEqual([
      { status: "done" },
    ]);
  });
  it("tells the Slack thread to check opencompany when the follow-up run never answers", async () => {
    await enqueueSlackThreadReply(execute, reply);
    await processNextSubscriptionEvent(deps);
    await pg.exec(
      `UPDATE goat.codex_chat_turns SET status = 'failed';
       UPDATE goat.codex_chat_sessions SET status = 'failed';
       UPDATE goat.tasks SET status = 'failed';
       UPDATE goat.chat_messages SET content = 'Task-only final answer' WHERE role = 'assistant';`,
    );
    expect(await processNextSubscriptionEvent(deps)).toBe(true);
    expect(
      (await pg.query("SELECT text FROM goat.channel_deliveries WHERE id <> 'root'")).rows,
    ).toEqual([
      {
        text: "The workflow needs attention. Open the task in opencompany to review and continue.",
      },
    ]);
  });
  it.each([
    { label: "a different email", profile: { email: "different@example.com" } },
    { label: "no email", profile: {} },
    { label: "a Slack guest", is_restricted: true, profile: {} },
    { label: "a single-channel guest", is_ultra_restricted: true, profile: {} },
  ])(
    "resumes for a participant with $label and no opencompany membership",
    async ({ label: _label, ...user }) => {
      await pg.exec("DELETE FROM goat.workspace_members WHERE user_workos_id = 'member'");
      deps.request = vi.fn(async () => ({
        user: { id: "U1", ...user },
      })) as unknown as SlackChannelWorkerDependencies["request"];
      await enqueueSlackThreadReply(execute, reply);
      await processNextSubscriptionEvent(deps);
      expect(
        (
          await pg.query(
            "SELECT status, run_id IS NOT NULL AS resumed FROM goat.subscription_events",
          )
        ).rows,
      ).toEqual([{ status: "running", resumed: true }]);
      expect(
        (
          await pg.query(
            "SELECT user_workos_id, chat_session_id, codex_chat_session_id FROM goat.codex_chat_turns",
          )
        ).rows,
      ).toEqual([
        { user_workos_id: "owner", chat_session_id: "session", codex_chat_session_id: "runtime" },
      ]);
      expect(
        (
          await pg.query(
            "SELECT author_workos_id, body FROM goat.task_activities WHERE kind = 'comment'",
          )
        ).rows,
      ).toEqual([
        {
          author_workos_id: "owner",
          body: expect.stringContaining("--- New follow-up message begins ---"),
        },
      ]);
    },
  );
  it("attributes the sender and includes the full thread before the clearly marked message", async () => {
    await enqueueSlackThreadReply(execute, reply);
    await processNextSubscriptionEvent(deps);
    const [activity] = (
      await pg.query<{ body: string }>(
        "SELECT body FROM goat.task_activities WHERE kind = 'comment'",
      )
    ).rows;
    expect(activity?.body).toContain("Sender: Member Person <member@example.com> (Slack user U1)");
    expect(activity?.body).toContain("opencompany bot (Slack user BOT):\n> Investigation result");
    expect(activity?.body).toContain(
      "Member Person <member@example.com> (Slack user U1):\n> What are the DB implications?",
    );
    expect(activity?.body).toContain(
      'call post_slack_message with your final Slack reply as text and "slack-follow-up-1" as messageKey',
    );
    expect(activity?.body.indexOf("--- Full Slack thread ---")).toBeLessThan(
      activity?.body.indexOf("--- New follow-up message begins ---") ?? 0,
    );
  });
  it.each([
    { id: "BOT" },
    { id: "U1", is_bot: true },
    { id: "U1", deleted: true },
    { id: "OTHER" },
  ])("ignores bot, deleted, or mismatched users: %j", async (user) => {
    deps.request = vi.fn(async () => ({
      user,
    })) as unknown as SlackChannelWorkerDependencies["request"];
    await enqueueSlackThreadReply(execute, {
      ...reply,
      slackUserId: user.id === "BOT" ? "BOT" : "U1",
    });
    await processNextSubscriptionEvent(deps);
    expect((await pg.query("SELECT status FROM goat.subscription_events")).rows).toEqual([
      { status: "ignored" },
    ]);
    expect((await pg.query("SELECT id FROM goat.codex_chat_turns")).rows).toHaveLength(0);
  });
  it.each([
    "UPDATE goat.session_subscriptions SET expires_at = now() - interval '1 day'",
    "UPDATE goat.session_subscriptions SET status = 'closed'",
    "UPDATE goat.tasks SET archived_at = now()",
    "UPDATE goat.chat_sessions SET closed_at = now()",
    "UPDATE goat.workflows SET slack_channel_enabled = false",
    "DELETE FROM goat.workspace_members WHERE user_workos_id = 'owner'",
  ])("closes unavailable work without creating a Run: %s", async (change) => {
    await pg.exec(change);
    await enqueueSlackThreadReply(execute, reply);
    await processNextSubscriptionEvent(deps);
    expect((await pg.query("SELECT id FROM goat.codex_chat_turns")).rows).toHaveLength(0);
    expect(
      (await pg.query("SELECT text FROM goat.channel_deliveries WHERE id <> 'root'")).rows,
    ).toEqual([{ text: expect.stringContaining("thread is closed") }]);
  });
  it("reconciles a lost Slack response after restart without reposting", async () => {
    await pg.exec(
      "UPDATE goat.channel_deliveries SET status = 'sending', message_ts = NULL, lease_expires_at = now() - interval '1 minute'; DELETE FROM goat.session_subscriptions",
    );
    deps.request = vi.fn(async () => ({
      messages: [
        {
          user: "BOT",
          ts: "100.001",
          metadata: { event_type: "opencompany_delivery", event_payload: { delivery_id: "root" } },
        },
      ],
    })) as unknown as SlackChannelWorkerDependencies["request"];
    await processNextChannelDelivery(deps);
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(deps.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "conversations.history" }),
    );
    expect((await pg.query("SELECT status FROM goat.channel_deliveries")).rows).toEqual([
      { status: "sent" },
    ]);
    expect((await pg.query("SELECT id FROM goat.session_subscriptions")).rows).toHaveLength(1);
  });
  it("posts under the workflow's display name only once the install can customize identity", async () => {
    await pg.exec(`UPDATE goat.channel_deliveries SET status = 'pending', message_ts = NULL, bot_display_name = 'James';
      DELETE FROM goat.session_subscriptions;`);
    deps.request = vi.fn(async () => ({
      ts: "200.001",
    })) as unknown as SlackChannelWorkerDependencies["request"];
    await processNextChannelDelivery(deps);
    expect(deps.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "chat.postMessage",
        form: expect.not.objectContaining({ username: expect.anything() }),
      }),
    );

    await pg.exec(`UPDATE goat.channel_deliveries SET status = 'pending', message_ts = NULL;
      UPDATE goat.integrations SET scopes = scopes || '["chat:write.customize"]'::jsonb;`);
    await processNextChannelDelivery(deps);
    expect(deps.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "chat.postMessage",
        form: expect.objectContaining({ username: "James" }),
      }),
    );
  });
  it("reconciles a customized post that Slack returns as an authorless bot message", async () => {
    await pg.exec(
      "UPDATE goat.channel_deliveries SET status = 'sending', message_ts = NULL, lease_expires_at = now() - interval '1 minute'; DELETE FROM goat.session_subscriptions",
    );
    deps.request = vi.fn(async () => ({
      messages: [
        {
          bot_id: "B1",
          username: "James",
          ts: "100.001",
          metadata: { event_type: "opencompany_delivery", event_payload: { delivery_id: "root" } },
        },
      ],
    })) as unknown as SlackChannelWorkerDependencies["request"];
    await processNextChannelDelivery(deps);
    expect((await pg.query("SELECT status FROM goat.channel_deliveries")).rows).toEqual([
      { status: "sent" },
    ]);
  });
  it("never redirects an old delivery into a reconnected Slack team", async () => {
    await pg.exec(
      "UPDATE goat.channel_deliveries SET status = 'pending'; UPDATE goat.integrations SET external_id = 'T_OTHER'",
    );
    expect(await processNextChannelDelivery(deps)).toBe(false);
    expect(deps.request).not.toHaveBeenCalled();
  });
  it("closes a late root confirmation after disconnect", async () => {
    await pg.exec(
      "DELETE FROM goat.session_subscriptions; UPDATE goat.integrations SET status = 'disconnected'",
    );
    await completeChannelDelivery(execute, {
      id: "root",
      teamId: "T1",
      channelId: "C1",
      threadTs: null,
      messageTs: "100.001",
    });
    expect((await pg.query("SELECT status FROM goat.session_subscriptions")).rows).toEqual([
      { status: "closed" },
    ]);
  });
  it("keeps an unconfirmed delivery uncertain instead of blindly repeating the external write", async () => {
    await pg.exec(
      "UPDATE goat.channel_deliveries SET status = 'sending', lease_expires_at = now() - interval '1 minute'",
    );
    deps.request = vi.fn(async () => ({
      messages: [],
    })) as unknown as SlackChannelWorkerDependencies["request"];
    await processNextChannelDelivery(deps);
    expect((await pg.query("SELECT status FROM goat.channel_deliveries")).rows).toEqual([
      { status: "uncertain" },
    ]);
    expect(await processNextChannelDelivery(deps)).toBe(false);
  });
});
