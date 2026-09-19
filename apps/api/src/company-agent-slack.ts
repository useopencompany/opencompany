import { randomUUID } from "node:crypto";
import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import {
  SLACK_AGENT_SCOPES,
  slackAgentManifest,
  slackAgentMessage,
} from "@opencompany/agent/integrations/slack-agent";
import { verifySlackEventSignature } from "@opencompany/agent/integrations/slack-signature";
import { type Actor, type CompanyAgentApplicationService, CoreError } from "@opencompany/core";
import { loadIntegrationCredential, saveIntegrationCredential } from "@opencompany/db/integrations";
import type { PooledDb } from "@opencompany/db/pool";
import { integrations } from "@opencompany/db/product-schema";
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
        installed,
        ready: installed && row?.status === "connected" && row.statusReason !== WAITING,
        status: installed ? row!.status : "not_connected",
        statusReason: installed ? row!.statusReason : null,
        teamName: installed ? row!.accountName : null,
        appUrl: row ? `https://api.slack.com/apps/${row.slackAppId}` : null,
        openUrl: installed
          ? `slack://app?team=${encodeURIComponent(row!.externalId)}&id=${encodeURIComponent(row!.slackAppId!)}`
          : null,
        eventsUrl: eventsUrl(agent.id),
        createUrl: createUrl.toString(),
        manifest: JSON.stringify(manifest, null, 2),
      };
    },
    async connect(
      actor: Actor,
      agentId: string,
      credentials: { botToken: string; signingSecret: string },
    ) {
      const agent = await owner(actor, agentId);
      // auth.test proves the token is installed; its response headers expose the
      // actual grants rather than trusting a client-provided scope list.
      const response = await fetcher("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${credentials.botToken}` },
        signal: AbortSignal.timeout(10000),
      });
      const auth = (await response.json().catch(() => null)) as {
        ok?: unknown;
        team_id?: unknown;
        user_id?: unknown;
        bot_id?: unknown;
        team?: unknown;
      } | null;
      if (
        !response.ok ||
        !auth ||
        auth.ok !== true ||
        typeof auth.team_id !== "string" ||
        !/^T[A-Z0-9]+$/.test(auth.team_id) ||
        typeof auth.user_id !== "string" ||
        !/^[UW][A-Z0-9]+$/.test(auth.user_id) ||
        typeof auth.bot_id !== "string" ||
        !/^B[A-Z0-9]+$/.test(auth.bot_id)
      )
        throw new CoreError(
          "invalid_argument",
          "Slack could not verify this bot token. Install the app in Slack and copy its Bot User OAuth Token.",
        );
      const teamId = auth.team_id;
      const botUserId = auth.user_id;
      const scopes = (response.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim());
      if (!SLACK_AGENT_SCOPES.every((scope) => scopes.includes(scope)))
        throw new CoreError(
          "invalid_argument",
          "The Slack app is missing required permissions. Apply the supplied manifest and reinstall the app.",
        );
      const bot = await request<{ bot?: { app_id?: string; user_id?: string } }>({
        token: credentials.botToken,
        method: "bots.info",
        form: { bot: auth.bot_id },
        signal: AbortSignal.timeout(10000),
      });
      const appId = bot.bot?.app_id;
      if (
        typeof appId !== "string" ||
        !/^A[A-Z0-9]+$/.test(appId) ||
        bot.bot?.user_id !== auth.user_id
      )
        throw new CoreError("invalid_argument", "Slack could not verify this app's bot identity.");
      // Reusing the shared app would only rename one bot. Reject that setup.
      const shared = await input.db
        .select()
        .from(integrations)
        .where(
          and(
            eq(integrations.provider, "slack_bot"),
            eq(integrations.externalId, teamId),
            sql`${integrations.companyAgentId} IS NULL`,
          ),
        );
      for (const row of shared) {
        const saved = await loadIntegrationCredential({
          integrationId: row.id,
          userWorkosId: row.userWorkosId,
          provider: "slack_bot",
          kind: "oauth_token",
          db: input.db,
        });
        if (saved?.payload.bot_user_id === auth.user_id)
          throw new CoreError(
            "invalid_argument",
            "Create a dedicated Slack app for this agent. The shared workspace bot cannot be used as a second identity.",
          );
      }

      await input.db.transaction(async (tx) => {
        // Serialize connect/reconnect per agent and preserve credential AAD attribution.
        await tx.execute(sql`SELECT id FROM goat.workflows WHERE id = ${agent.id} FOR UPDATE`);
        const [existing] = await tx
          .select()
          .from(integrations)
          .where(eq(integrations.companyAgentId, agent.id));
        const other = await tx
          .select({ id: integrations.id })
          .from(integrations)
          .where(and(eq(integrations.externalId, teamId), eq(integrations.slackAppId, appId)));
        if (other.some((row) => row.id !== existing?.id))
          throw new CoreError(
            "conflict",
            "This Slack app is already connected to another company agent.",
          );
        if (existing && (existing.externalId !== auth.team_id || existing.slackAppId !== appId))
          throw new CoreError(
            "conflict",
            "Reconnect this agent's original Slack app. Create another agent to use a different app.",
          );
        const id = existing?.id ?? `integration_${randomUUID()}`;
        const userWorkosId = existing?.userWorkosId ?? actor.userId;
        await tx
          .insert(integrations)
          .values({
            id,
            userWorkosId,
            workspaceId: actor.workspaceId,
            companyAgentId: agent.id,
            slackAppId: appId,
            provider: "slack_bot",
            externalId: teamId,
            connectionLabel: agent.name,
            accountName: typeof auth.team === "string" ? auth.team : "Slack",
            accountType: "slack_bot",
            scopes,
            status: "connected",
            statusReason: WAITING,
          })
          .onConflictDoUpdate({
            target: integrations.id,
            set: { scopes, status: "connected", statusReason: WAITING, updatedAt: new Date() },
          });
        await saveIntegrationCredential({
          integrationId: id,
          userWorkosId,
          provider: "slack_bot",
          kind: "oauth_token",
          db: tx,
          payload: {
            access_token: credentials.botToken,
            signing_secret: credentials.signingSecret,
            bot_user_id: botUserId,
            team_id: teamId,
            app_id: appId,
          },
        });
      });
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
