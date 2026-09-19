import { randomUUID } from "node:crypto";
import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import { SLACK_AGENT_SCOPES } from "@opencompany/agent/integrations/slack-agent";
import { type Actor, CoreError } from "@opencompany/core";
import { loadIntegrationCredential, saveIntegrationCredential } from "@opencompany/db/integrations";
import type { PooledDb } from "@opencompany/db/pool";
import { integrations } from "@opencompany/db/product-schema";
import { and, eq, sql } from "drizzle-orm";

export const SLACK_AGENT_WAITING = "Waiting for Slack event verification.";
const WAITING = SLACK_AGENT_WAITING;
export async function bindSlackAgent(input: {
  db: PooledDb;
  actor: Actor;
  agent: { id: string; name: string };
  credentials: { botToken: string; signingSecret: string };
  fetch?: typeof globalThis.fetch;
  request?: typeof slackApiRequest;
}) {
  const { actor, agent, credentials } = input;
  const fetcher = input.fetch ?? globalThis.fetch;
  const request = input.request ?? slackApiRequest;
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
  if (typeof appId !== "string" || !/^A[A-Z0-9]+$/.test(appId) || bot.bot?.user_id !== auth.user_id)
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
}
