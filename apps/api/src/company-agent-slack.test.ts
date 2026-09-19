import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SLACK_AGENT_SCOPES } from "@opencompany/agent/integrations/slack-agent";
import type { Actor, CompanyAgentApplicationService } from "@opencompany/core";
import type { PooledDb } from "@opencompany/db/pool";
import { createTestPGlite } from "@opencompany/db/test-pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompanyAgentSlackService } from "./company-agent-slack";

let pg: Awaited<ReturnType<typeof createTestPGlite>>;
let service: ReturnType<typeof createCompanyAgentSlackService>;
const actor: Actor = {
  userId: "owner",
  workspaceId: "workspace",
  role: "admin",
  permissions: [],
  authenticationMethod: "service",
};
const secret = "a".repeat(32);
let selectedApp = "A1";
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  selectedApp = "A1";
  pg = await createTestPGlite();
  await pg.exec(`CREATE SCHEMA goat;
    CREATE TABLE goat.workflows(id text PRIMARY KEY, workspace_id text, kind text DEFAULT 'agent', status text DEFAULT 'active', archived_at timestamptz, slack_channel_enabled boolean DEFAULT true);
    INSERT INTO goat.workflows(id, workspace_id) VALUES ('agent1', 'workspace'), ('agent2', 'workspace');
    CREATE TABLE goat.integrations(id text PRIMARY KEY, user_workos_id text NOT NULL, workspace_id text,
      shared_with_workspace boolean DEFAULT false, provider text NOT NULL, external_id text NOT NULL,
      connection_label text, account_name text, account_email text, account_type text, status text DEFAULT 'connected', status_reason text,
      scopes jsonb DEFAULT '[]', capability_modes jsonb DEFAULT '{}', tool_modes jsonb DEFAULT '{}',
      last_synced_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX goat_integrations_workspace_provider_external_idx ON goat.integrations(workspace_id, provider, external_id) WHERE workspace_id IS NOT NULL;
    CREATE UNIQUE INDEX goat_integrations_slack_bot_workspace_idx ON goat.integrations(workspace_id, provider) WHERE workspace_id IS NOT NULL AND provider = 'slack_bot';
    CREATE TABLE goat.integration_credentials(id text PRIMARY KEY, user_workos_id text, integration_id text, provider text, kind text,
      encrypted_payload jsonb, encryption_key_version integer, expires_at timestamptz, last_rotated_at timestamptz, refresh_lease_until timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz,
      UNIQUE(integration_id, kind));
    CREATE TABLE goat.session_subscriptions(id text PRIMARY KEY, integration_id text, source_key jsonb, status text DEFAULT 'waiting');
    CREATE TABLE goat.channel_deliveries(id text PRIMARY KEY, integration_id text, status text);
  `);
  await pg.exec(
    await readFile(
      new URL("../../../drizzle/0305_company_agent_slack.sql", import.meta.url),
      "utf8",
    ),
  );
  fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          team_id: "T1",
          user_id: `U${selectedApp}`,
          bot_id: `B${selectedApp}`,
          team: "Test Slack",
        }),
        { headers: { "x-oauth-scopes": SLACK_AGENT_SCOPES.join(",") } },
      ),
  );
  service = createCompanyAgentSlackService({
    db: drizzle(pg) as unknown as PooledDb,
    apiOrigin: "https://api.example.com",
    fetch: fetcher as typeof fetch,
    request: vi.fn(async () => ({
      bot: { app_id: selectedApp, user_id: `U${selectedApp}` },
    })) as never,
    agents: {
      getAgent: vi.fn(async (a: Actor, id: string) => {
        if (a.workspaceId !== "workspace") throw new Error("not found");
        return { id, name: "Support", ownerUserId: "owner", ownerActive: true };
      }),
    } as unknown as CompanyAgentApplicationService,
  });
});
afterEach(async () => {
  await pg.close();
  vi.unstubAllEnvs();
});
const connect = (id = "agent1") =>
  service.connect(actor, id, { botToken: "xoxb-test", signingSecret: secret });
function signed(body: unknown, signingSecret = secret) {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${text}`).digest("hex")}`;
  return new Request("https://api.example.com/events", {
    method: "POST",
    body: text,
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
  });
}
const envelope = (event: Record<string, unknown>, app = "A1") => ({
  type: "event_callback",
  api_app_id: app,
  team_id: "T1",
  event_id: "Ev1",
  event,
});
const mention = {
  type: "app_mention",
  channel: "C1",
  user: "U1",
  ts: "100.001",
  text: "<@UA1> help",
};

describe("company agent Slack setup and ingress", () => {
  it("binds two distinct apps in the same team, encrypts credentials and waits for signed verification", async () => {
    expect(await connect()).toMatchObject({ installed: true, ready: false });
    selectedApp = "A2";
    await connect("agent2");
    expect(
      (await pg.query("SELECT company_agent_id FROM goat.integrations ORDER BY company_agent_id"))
        .rows,
    ).toEqual([{ company_agent_id: "agent1" }, { company_agent_id: "agent2" }]);
    const serialized = JSON.stringify(
      (await pg.query("SELECT * FROM goat.integration_credentials")).rows,
    );
    expect(serialized).not.toContain("xoxb-test");
    expect(serialized).not.toContain(secret);
    const response = await service.webhook(
      "agent1",
      signed({ type: "url_verification", challenge: "challenge" }),
    );
    expect(await response.json()).toEqual({ challenge: "challenge" });
    expect(await service.get(actor, "agent1")).toMatchObject({ ready: true });
    expect(await service.get(actor, "agent2")).toMatchObject({ ready: false });
  });
  it("rejects non-owners and missing Slack scopes before persisting", async () => {
    await expect(
      service.connect({ ...actor, userId: "member" }, "agent1", {
        botToken: "xoxb-test",
        signingSecret: secret,
      }),
    ).rejects.toThrow("owner");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" })),
    );
    await expect(connect()).rejects.toThrow("permissions");
    expect((await pg.query("SELECT * FROM goat.integrations")).rows).toHaveLength(0);
  });
  it("does not let two agents reuse the same Slack identity", async () => {
    await connect();
    await expect(connect("agent2")).rejects.toThrow("already connected");
  });
  it("rejects wrong signatures and cross-app or cross-team events", async () => {
    await connect();
    expect((await service.webhook("agent1", signed(envelope(mention), "wrong"))).status).toBe(401);
    await service.webhook("agent1", signed(envelope(mention, "A2")));
    await service.webhook("agent1", signed({ ...envelope(mention), team_id: "T2" }));
    expect((await pg.query("SELECT * FROM goat.slack_agent_messages")).rows).toHaveLength(0);
  });
  it("deduplicates retries and captures a first mention in an existing thread", async () => {
    await connect();
    for (let i = 0; i < 3; i++)
      await service.webhook("agent1", signed(envelope({ ...mention, thread_ts: "99.001" })));
    const rows = (await pg.query("SELECT thread_ts, message_ts FROM goat.slack_agent_messages"))
      .rows;
    expect(rows).toEqual([{ thread_ts: "99.001", message_ts: "100.001" }]);
  });
  it("only captures unmentioned replies for a thread belonging to this agent", async () => {
    await connect();
    const followup = { ...mention, type: "message", channel_type: "channel", thread_ts: "99.001" };
    await service.webhook("agent1", signed(envelope(followup)));
    expect((await pg.query("SELECT * FROM goat.slack_agent_messages")).rows).toHaveLength(0);
    await pg.exec(
      `INSERT INTO goat.session_subscriptions(id, integration_id, source_key) SELECT 'thread', id, '{"channelId":"C1","threadTs":"99.001"}' FROM goat.integrations`,
    );
    await service.webhook("agent1", signed(envelope(followup)));
    expect((await pg.query("SELECT * FROM goat.slack_agent_messages")).rows).toHaveLength(1);
  });
  it("stops accepting messages for a paused agent and disconnect closes threads and removes credentials", async () => {
    await connect();
    await pg.exec("UPDATE goat.workflows SET status = 'draft'");
    await service.webhook("agent1", signed(envelope(mention)));
    expect((await pg.query("SELECT * FROM goat.slack_agent_messages")).rows).toHaveLength(0);
    await pg.exec(
      `INSERT INTO goat.session_subscriptions(id, integration_id) SELECT 'thread', id FROM goat.integrations`,
    );
    await service.disconnect(actor, "agent1");
    expect((await pg.query("SELECT status FROM goat.session_subscriptions")).rows).toEqual([
      { status: "closed" },
    ]);
    expect((await pg.query("SELECT * FROM goat.integration_credentials")).rows).toHaveLength(0);
    expect((await service.webhook("agent1", signed(envelope(mention)))).status).toBe(404);
  });
});
