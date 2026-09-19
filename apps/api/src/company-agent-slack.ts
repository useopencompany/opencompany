import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import { slackAgentManifest, slackAgentMessage } from "@opencompany/agent/integrations/slack-agent";
import { bindSlackAgent } from "@opencompany/agent/integrations/slack-agent-binding";
import { verifySlackEventSignature } from "@opencompany/agent/integrations/slack-signature";
import { type Actor, type CompanyAgentApplicationService, CoreError } from "@opencompany/core";
import { loadIntegrationCredential } from "@opencompany/db/integrations";
import type { PooledDb } from "@opencompany/db/pool";
import { integrations } from "@opencompany/db/product-schema";
import { subscriptionRows as rows } from "@opencompany/db/session-subscriptions";
import { and, eq, sql } from "drizzle-orm";

const WAITING = "Waiting for Slack event verification.";
export type CompanyAgentSlackService = ReturnType<typeof createCompanyAgentSlackService>;

export function createCompanyAgentSlackService(input: {
  db: PooledDb;
  agents: CompanyAgentApplicationService;
  apiOrigin: string;
  fetch?: typeof globalThis.fetch;
  request?: typeof slackApiRequest;
}) {
  const request = input.request ?? slackApiRequest;
  const fetcher = input.fetch ?? globalThis.fetch;
  const installation = async (agentId: string) =>
    (
      await input.db
        .select()
        .from(integrations)
        .where(eq(integrations.companyAgentId, agentId))
        .limit(1)
    )[0];

  async function owner(actor: Actor, agentId: string) {
    const agent = await input.agents.getAgent(actor, agentId);
    if (agent.ownerUserId !== actor.userId || !agent.ownerActive)
      throw new CoreError("forbidden", "Only this agent's active owner can connect Slack.");
    return agent;
  }
  function eventsUrl(agentId: string) {
    return new URL(
      `/webhooks/slack-agents/${encodeURIComponent(agentId)}/events`,
      input.apiOrigin,
    ).toString();
  }
  return {
    async get(actor: Actor, agentId: string) {
      const agent = await input.agents.getAgent(actor, agentId);
      const row = await installation(agent.id);
      const installed = Boolean(row && row.status !== "disconnected");
      const [connection] = rows<{ status: string }>(
        await input.db.execute(
          sql`SELECT status FROM goat.slack_provisioning_connections WHERE workspace_id = ${actor.workspaceId}`,
        ),
      );
      const [job] = rows<{ state: string; reason: string | null; appId: string | null }>(
        await input.db.execute(
          sql`SELECT state, reason, app_id AS "appId" FROM goat.slack_agent_provisioning WHERE agent_id = ${agent.id}`,
        ),
      );
      const manifest = slackAgentManifest({
        name: agent.name,
        ...(installed ? { eventsUrl: eventsUrl(agent.id) } : {}),
      });
      const createUrl = new URL("https://api.slack.com/apps");
      createUrl.searchParams.set("new_app", "1");
      createUrl.searchParams.set(
        "manifest_json",
        JSON.stringify(slackAgentManifest({ name: agent.name })),
      );
      return {
        provisioning: {
          configured: connection?.status === "connected",
          state: job?.state ?? "not_started",
          reason: job?.reason ?? null,
        },
        installed,
        ready: installed && row?.status === "connected" && row.statusReason !== WAITING,
        status: installed ? row!.status : "not_connected",
        statusReason: installed ? row!.statusReason : null,
        teamName: installed ? row!.accountName : null,
        appUrl:
          row?.slackAppId || job?.appId
            ? `https://api.slack.com/apps/${row?.slackAppId ?? job?.appId}`
            : null,
        openUrl: installed
          ? `slack://app?team=${encodeURIComponent(row!.externalId)}&id=${encodeURIComponent(row!.slackAppId!)}`
          : null,
        eventsUrl: eventsUrl(agent.id),
        createUrl: createUrl.toString(),
        manifest: JSON.stringify(manifest, null, 2),
      };
    },
    async configure(
      actor: Actor,
      agentId: string,
      body: {} | { botToken: string; signingSecret: string },
    ) {
      if ("botToken" in body) return this.connect(actor, agentId, body);
      const agent = await owner(actor, agentId);
      if (!agent.slackEnabled)
        throw new CoreError("invalid_argument", "Turn on Slack for this agent first.");
      const [connection] = rows<{ teamId: string }>(
        await input.db.execute(
          sql`SELECT team_id AS "teamId" FROM goat.slack_provisioning_connections WHERE workspace_id = ${actor.workspaceId} AND status = 'connected'`,
        ),
      );
      if (!connection)
        throw new CoreError(
          "invalid_argument",
          "Ask an admin to set up Slack identities in Settings → Channels → Slack.",
        );
      await input.db.execute(sql`UPDATE goat.slack_agent_provisioning SET state = CASE WHEN app_id IS NULL THEN 'queued' ELSE 'created' END, reason = NULL, lease_until = NULL, updated_at = now()
        WHERE agent_id = ${agent.id} AND (state = 'failed' OR (state = 'ready' AND EXISTS (SELECT 1 FROM goat.integrations WHERE company_agent_id = ${agent.id} AND status IN ('needs_reauth', 'sync_failed', 'disconnected')))) AND (lease_until IS NULL OR lease_until < now())`);
      return this.get(actor, agent.id);
    },
    async connect(
      actor: Actor,
      agentId: string,
      credentials: { botToken: string; signingSecret: string },
    ) {
      const agent = await owner(actor, agentId);
      await bindSlackAgent({ db: input.db, actor, agent, credentials, fetch: fetcher, request });
      return this.get(actor, agent.id);
    },
    async disconnect(actor: Actor, agentId: string) {
      const agent = await owner(actor, agentId);
      await input.db.transaction(async (tx) => {
        const rows = await tx
          .update(integrations)
          .set({ status: "disconnected", updatedAt: new Date() })
          .where(eq(integrations.companyAgentId, agent.id))
          .returning({ id: integrations.id });
        for (const row of rows) {
          await tx.execute(
            sql`UPDATE goat.session_subscriptions SET status = 'closed' WHERE integration_id = ${row.id}`,
          );
          await tx.execute(
            sql`UPDATE goat.channel_deliveries SET status = 'canceled' WHERE integration_id = ${row.id} AND status = 'pending'`,
          );
          await tx.execute(
            sql`UPDATE goat.slack_agent_messages SET status = 'ignored' WHERE integration_id = ${row.id} AND status = 'pending'`,
          );
          await tx.execute(
            sql`DELETE FROM goat.integration_credentials WHERE integration_id = ${row.id}`,
          );
        }
      });
    },
    async webhook(agentId: string, req: Request) {
      const row = await installation(agentId);
      if (!row || row.status === "disconnected") return new Response(null, { status: 404 });
      const credential = await loadIntegrationCredential({
        integrationId: row.id,
        userWorkosId: row.userWorkosId,
        provider: "slack_bot",
        kind: "oauth_token",
        db: input.db,
      });
      const rawBody = await req.text();
      if (
        !verifySlackEventSignature({
          rawBody,
          timestamp: req.headers.get("x-slack-request-timestamp"),
          signature: req.headers.get("x-slack-signature"),
          secret: credential?.payload.signing_secret as string | undefined,
        })
      )
        return new Response(null, { status: 401 });
      let body: {
        type?: string;
        challenge?: string;
        team_id?: string;
        api_app_id?: string;
        event_id?: string;
        event?: Record<string, unknown>;
      };
      try {
        body = JSON.parse(rawBody);
      } catch {
        return new Response(null, { status: 400 });
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return new Response(null, { status: 400 });
      if (body.type === "url_verification" && typeof body.challenge === "string") {
        await input.db
          .update(integrations)
          .set({ statusReason: null, updatedAt: new Date() })
          .where(eq(integrations.id, row.id));
        return Response.json({ challenge: body.challenge });
      }
      if (
        body.type !== "event_callback" ||
        body.team_id !== row.externalId ||
        body.api_app_id !== row.slackAppId ||
        typeof body.event_id !== "string" ||
        !body.event_id ||
        body.event_id.length > 255 ||
        !body.event ||
        typeof body.event !== "object" ||
        Array.isArray(body.event)
      )
        return Response.json({ ok: true, ignored: true });
      if (["tokens_revoked", "app_uninstalled"].includes(String(body.event.type))) {
        await input.db
          .update(integrations)
          .set({
            status: "needs_reauth",
            statusReason: "Reconnect this agent's Slack app.",
            updatedAt: new Date(),
          })
          .where(eq(integrations.id, row.id));
        return Response.json({ ok: true });
      }
      // Manifest provisioning can deliver events without a new URL challenge.
      // A signed event for this installation also proves the endpoint is reachable.
      if (row.status === "connected" && row.statusReason === WAITING) {
        await input.db
          .update(integrations)
          .set({ statusReason: null, updatedAt: new Date() })
          .where(
            and(
              eq(integrations.id, row.id),
              eq(integrations.status, "connected"),
              eq(integrations.statusReason, WAITING),
            ),
          );
      }
      const message = slackAgentMessage(body.event, String(credential?.payload.bot_user_id));
      if (!message || row.status !== "connected") return Response.json({ ok: true, ignored: true });
      await input.db.execute(sql`
        INSERT INTO goat.slack_agent_messages (integration_id, event_id, channel_id, thread_ts, message_ts, slack_user_id, text)
        SELECT ${row.id}, ${body.event_id}, ${message.channelId}, ${message.threadTs}, ${message.messageTs}, ${message.slackUserId}, ${message.text}
        WHERE EXISTS (SELECT 1 FROM goat.workflows WHERE id = ${agentId} AND status = 'active' AND archived_at IS NULL AND slack_channel_enabled)
          AND (${message.canStart} OR EXISTS (SELECT 1 FROM goat.session_subscriptions WHERE integration_id = ${row.id}
            AND source_key->>'channelId' = ${message.channelId} AND source_key->>'threadTs' = ${message.threadTs}))
        ON CONFLICT (integration_id, channel_id, message_ts) DO NOTHING
      `);
      return Response.json({ ok: true });
    },
  };
}
