import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SLACK_AGENT_SCOPES } from "@opencompany/agent/integrations/slack-agent";
import {
  processNextSlackProvisioning,
  SlackProvisioningError,
  sealSlackSecret,
} from "@opencompany/agent/integrations/slack-provisioning";
import type { Actor, CompanyAgentApplicationService } from "@opencompany/core";
import type { PooledDb } from "@opencompany/db/pool";
import { createTestPGlite } from "@opencompany/db/test-pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompanyAgentSlackService } from "./company-agent-slack";
import { createSlackProvisioningService } from "./slack-provisioning";

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
  vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://app.example.com");
  selectedApp = "A1";
  pg = await createTestPGlite();
  await pg.exec(`CREATE SCHEMA goat;
    CREATE TABLE goat.users(workos_user_id text PRIMARY KEY);
    INSERT INTO goat.users VALUES ('owner');
    CREATE TABLE goat.workspaces(id text PRIMARY KEY);
    INSERT INTO goat.workspaces VALUES ('workspace');
    CREATE TABLE goat.workspace_members(workspace_id text, user_workos_id text, role text DEFAULT 'admin');
    INSERT INTO goat.workspace_members(workspace_id, user_workos_id) VALUES ('workspace', 'owner');
    CREATE TABLE goat.workflows(id text PRIMARY KEY, workspace_id text, kind text DEFAULT 'agent', status text DEFAULT 'active', archived_at timestamptz, slack_channel_enabled boolean DEFAULT true, name text DEFAULT 'Support', owner_workos_id text DEFAULT 'owner', slack_bot_avatar_url text DEFAULT '');
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
  await pg.exec(
    await readFile(
      new URL("../../../drizzle/0306_slack_agent_provisioning.sql", import.meta.url),
      "utf8",
    ),
  );
  await pg.exec("UPDATE goat.workflows SET slack_channel_enabled = true");
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
        return { id, name: "Support", ownerUserId: "owner", ownerActive: true, slackEnabled: true };
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
    expect(await service.get(actor, "agent1")).toMatchObject({ ready: false });
  });
  it("recognizes signed event delivery when manifest setup did not send a URL challenge", async () => {
    await connect();
    selectedApp = "A2";
    await connect("agent2");
    await service.webhook("agent1", signed(envelope(mention)));
    expect(await service.get(actor, "agent1")).toMatchObject({ ready: true, statusReason: null });
    expect(await service.get(actor, "agent2")).toMatchObject({ ready: false });
    expect((await pg.query("SELECT * FROM goat.slack_agent_messages")).rows).toHaveLength(1);
  });
  it("does not mark a revoked installation ready on subsequent signed events", async () => {
    await connect();
    await service.webhook("agent1", signed(envelope({ type: "tokens_revoked" })));
    await service.webhook("agent1", signed(envelope(mention)));
    expect(await service.get(actor, "agent1")).toMatchObject({
      ready: false,
      status: "needs_reauth",
      statusReason: "Reconnect this agent's Slack app.",
    });
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

describe("automatic Slack identities", () => {
  async function authorize() {
    const encrypted = sealSlackSecret("workspace", "connection", { token: "service-test" });
    await pg.query(
      `INSERT INTO goat.slack_provisioning_connections(workspace_id, team_id, team_name, authorized_by, slack_user_id, encrypted_payload) VALUES ('workspace', 'T1', 'Test Slack', 'owner', 'U1', $1)`,
      [JSON.stringify(encrypted)],
    );
    await pg.exec("UPDATE goat.workflows SET slack_channel_enabled = false WHERE id = 'agent2'");
  }
  function worker(request: any) {
    return processNextSlackProvisioning({
      db: drizzle(pg) as unknown as PooledDb,
      apiOrigin: "https://api.example.com",
      request,
      bind: async ({ agent, credentials }) => {
        await service.connect(actor, agent.id, credentials);
      },
    });
  }
  const requests = () =>
    vi.fn(async (method: string) => {
      if (method === "apps.manifest.create")
        return { ok: true, app_id: "A1", team_id: "T1", credentials: { signing_secret: secret } };
      if (method === "apps.developerInstall")
        return { ok: true, app_id: "A1", team_id: "T1", api_access_tokens: { bot: "xoxb-test" } };
      return { ok: true };
    });
  it("does nothing while Slack is off, then creates one native identity and resumes each persisted stage", async () => {
    await authorize();
    await pg.exec("UPDATE goat.workflows SET slack_channel_enabled = false");
    const request = requests();
    expect(await worker(request)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    await pg.exec("UPDATE goat.workflows SET slack_channel_enabled = true WHERE id = 'agent1'");
    expect(await worker(request)).toBe(true);
    expect(await worker(request)).toBe(true);
    expect(await worker(request)).toBe(true);
    expect(await worker(request)).toBe(false);
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "apps.manifest.create",
      "apps.developerInstall",
      "apps.manifest.update",
      "apps.icon.set",
    ]);
    const result = await service.get(actor, "agent1");
    expect(result).toMatchObject({
      installed: true,
      ready: false,
      provisioning: { configured: true, state: "ready" },
    });
    expect((await pg.query("SELECT company_agent_id FROM goat.integrations")).rows).toEqual([
      { company_agent_id: "agent1" },
    ]);
    await pg.exec("UPDATE goat.workflows SET name = 'Renamed' WHERE id = 'agent1'");
    expect(await worker(request)).toBe(true);
    expect(request.mock.calls.filter((c) => c[0] === "apps.manifest.create")).toHaveLength(1);
    expect(await worker(request)).toBe(false);
  });
  it("never recreates an app after an ambiguous create or a crashed create lease", async () => {
    await authorize();
    const request = vi.fn(async () => {
      throw new SlackProvisioningError("request_unconfirmed");
    });
    await worker(request);
    await service.configure(actor, "agent1", {});
    expect(await worker(request)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect((await service.get(actor, "agent1")).provisioning.state).toBe("uncertain");
    await pg.exec(
      "UPDATE goat.slack_agent_provisioning SET state = 'creating', lease_until = now() - interval '1 minute'",
    );
    expect(await worker(request)).toBe(false);
    expect((await service.get(actor, "agent1")).provisioning.state).toBe("uncertain");
  });
  it("retries installation on the saved app after approval without creating another app", async () => {
    await authorize();
    const request = requests();
    await worker(request);
    const denied = vi.fn(async () => {
      throw new SlackProvisioningError("app_approval_request_pending");
    });
    await worker(denied);
    expect((await service.get(actor, "agent1")).provisioning.state).toBe("failed");
    await service.configure(actor, "agent1", {});
    await worker(request);
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "apps.manifest.create",
      "apps.developerInstall",
    ]);
  });
  it("reinstalls a ready app after message processing marks its integration failed", async () => {
    await authorize();
    const request = requests();
    await worker(request);
    await worker(request);
    await worker(request);
    await pg.exec(
      "UPDATE goat.integrations SET status = 'sync_failed', status_reason = 'Slack could not start this conversation.'",
    );

    await service.configure(actor, "agent1", {});

    expect((await service.get(actor, "agent1")).provisioning.state).toBe("created");
    await worker(request);
    expect(await service.get(actor, "agent1")).toMatchObject({
      status: "connected",
      provisioning: { state: "installed" },
    });
    expect(request.mock.calls.filter((call) => call[0] === "apps.manifest.create")).toHaveLength(1);
    expect(request.mock.calls.filter((call) => call[0] === "apps.developerInstall")).toHaveLength(
      2,
    );
  });
  it("can retry a local configuration failure without claiming Slack created an app", async () => {
    await authorize();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "not a URL");
    const request = requests();
    await worker(request);
    expect(request).not.toHaveBeenCalled();
    expect((await service.get(actor, "agent1")).provisioning.state).toBe("failed");
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://app.example.com");
    await service.configure(actor, "agent1", {});
    await worker(request);
    expect(request.mock.calls.map((c) => c[0])).toEqual(["apps.manifest.create"]);
  });
  it("serializes concurrent workers before the remote app creation", async () => {
    await authorize();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normal = requests();
    const request = vi.fn(async (method: string) => {
      started();
      await blocked;
      return normal(method);
    });
    const first = worker(request);
    await entered;
    expect(await worker(request)).toBe(false);
    release();
    await first;
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("stops provisioning when the authorizing admin loses their role", async () => {
    await authorize();
    await pg.exec("UPDATE goat.workspace_members SET role = 'member'");
    const request = requests();
    expect(await worker(request)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect((await service.get(actor, "agent1")).provisioning.configured).toBe(false);
  });
  it("keeps installed bot credentials when disconnecting identity setup", async () => {
    await authorize();
    const request = requests();
    await worker(request);
    await worker(request);
    const setup = createSlackProvisioningService({ db: drizzle(pg) as unknown as PooledDb });
    await setup.disconnect(actor);
    expect(await worker(request)).toBe(false);
    expect((await service.get(actor, "agent1")).installed).toBe(true);
    expect((await pg.query("SELECT id FROM goat.integration_credentials")).rows).toHaveLength(1);
  });
  it("requires confirming the same workspace and preserves the previous grant on mismatch", async () => {
    await authorize();
    const setup = createSlackProvisioningService({
      db: drizzle(pg) as unknown as PooledDb,
      request: async (method) =>
        method.endsWith("generateAuthTicket")
          ? { ticket: "test-ticket" }
          : {
              token: "different-service-token",
              team_id: "T2",
              team_name: "Other Slack",
              user_id: "U2",
            },
    });
    const attempt = await setup.start(actor);
    await setup.complete(actor, attempt.attemptId, "code");
    await expect(setup.confirm(actor, attempt.attemptId)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await setup.get(actor)).toMatchObject({ configured: true, teamName: "Test Slack" });
  });
  it("authorizes admins with a single-use, workspace- and user-bound attempt and keeps credentials out of responses", async () => {
    const request = vi.fn(async (method: string) =>
      method.endsWith("generateAuthTicket")
        ? { ticket: "test-ticket" }
        : { token: "service-test", team_id: "T1", team_name: "Test Slack", user_id: "U1" },
    );
    const setup = createSlackProvisioningService({
      db: drizzle(pg) as unknown as PooledDb,
      request,
    });
    await expect(setup.start({ ...actor, role: "member" })).rejects.toMatchObject({
      code: "forbidden",
    });
    const expired = await setup.start(actor);
    await pg.query(
      "UPDATE goat.slack_provisioning_attempts SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.attemptId],
    );
    await expect(setup.complete(actor, expired.attemptId, "code")).rejects.toThrow("expired");
    const attempt = await setup.start(actor);
    await expect(
      setup.complete({ ...actor, userId: "another-admin" }, attempt.attemptId, "code"),
    ).rejects.toThrow("expired");
    await expect(
      setup.complete({ ...actor, workspaceId: "other" }, attempt.attemptId, "code"),
    ).rejects.toThrow("expired");
    await expect(setup.complete(actor, attempt.attemptId, "code")).resolves.toEqual({
      configured: false,
      status: "awaiting_confirmation",
      teamName: "Test Slack",
    });
    expect(await setup.get(actor)).toMatchObject({ configured: false });
    await expect(setup.confirm(actor, attempt.attemptId)).resolves.toEqual({
      configured: true,
      status: "connected",
      teamName: "Test Slack",
    });
    await expect(setup.confirm(actor, attempt.attemptId)).rejects.toThrow("expired");
    await expect(setup.complete(actor, attempt.attemptId, "code")).rejects.toThrow("expired");
    expect(
      JSON.stringify(
        await pg.query("SELECT encrypted_payload FROM goat.slack_provisioning_connections"),
      ),
    ).not.toContain("service-test");
    await setup.disconnect(actor);
    expect(await setup.get(actor)).toMatchObject({ configured: false, status: "disconnected" });
  });
});
