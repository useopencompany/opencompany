import { randomUUID } from "node:crypto";
import {
  openSlackSecret,
  type ProvisioningRequest,
  requiredSlackString,
  SlackProvisioningError,
  sealSlackSecret,
  slackProvisioningRequest,
} from "@opencompany/agent/integrations/slack-provisioning";
import { type Actor, CoreError } from "@opencompany/core";
import type { EncryptedPayload } from "@opencompany/crypto";
import type { PooledDb } from "@opencompany/db/pool";
import { subscriptionRows as rows } from "@opencompany/db/session-subscriptions";
import { sql } from "drizzle-orm";

export function createSlackProvisioningService(input: {
  db: PooledDb;
  request?: ProvisioningRequest;
}) {
  const { db } = input;
  const request = input.request ?? slackProvisioningRequest;
  function admin(actor: Actor) {
    if (actor.role !== "admin")
      throw new CoreError("forbidden", "Only workspace admins can set up Slack identities.");
  }
  return {
    async get(actor: Actor) {
      const [connection] = rows<{ status: string; teamName: string }>(
        await db.execute(
          sql`SELECT status, team_name AS "teamName" FROM goat.slack_provisioning_connections WHERE workspace_id = ${actor.workspaceId}`,
        ),
      );
      return {
        configured: connection?.status === "connected",
        status: connection?.status ?? "not_connected",
        teamName: connection?.teamName ?? null,
      };
    },
    async start(actor: Actor) {
      admin(actor);
      const result = await request("apps.hosted.generateAuthTicket", {
        slack_cli_version: "v4.8",
        no_rotation: true,
      });
      const ticket = requiredSlackString(result.ticket, /^[A-Za-z0-9_-]+$/);
      const id = randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`DELETE FROM goat.slack_provisioning_attempts WHERE workspace_id = ${actor.workspaceId} AND (user_id = ${actor.userId} OR expires_at < now())`,
        );
        await tx.execute(sql`INSERT INTO goat.slack_provisioning_attempts (id, workspace_id, user_id, encrypted_payload, expires_at)
          VALUES (${id}, ${actor.workspaceId}, ${actor.userId}, ${JSON.stringify(sealSlackSecret(actor.workspaceId, id, { ticket }))}::jsonb, now() + interval '10 minutes')`);
      });
      return {
        attemptId: id,
        command: `/slackauthticket ${ticket}`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },
    async complete(actor: Actor, attemptId: string, challenge: string) {
      admin(actor);
      // Consume before exchanging. A challenge is short-lived and single-use; after an interrupted
      // exchange a new attempt is safer than replaying an authorization of uncertain outcome.
      const [attempt] = rows<{ encrypted: EncryptedPayload; version: number }>(
        await db.execute(sql`
        UPDATE goat.slack_provisioning_attempts SET consumed_at = now()
        WHERE id = ${attemptId} AND workspace_id = ${actor.workspaceId} AND user_id = ${actor.userId} AND consumed_at IS NULL AND expires_at > now()
        RETURNING encrypted_payload AS encrypted, encryption_key_version AS version`),
      );
      if (!attempt)
        throw new CoreError(
          "invalid_argument",
          "This setup attempt expired or was already used. Start again.",
        );
      const ticket = requiredSlackString(
        openSlackSecret(actor.workspaceId, attemptId, attempt.encrypted, attempt.version).ticket,
      );
      let result: Record<string, any>;
      try {
        result = await request("apps.hosted.exchangeAuthTicket", {
          ticket,
          challenge,
          slack_cli_version: "v4.8",
        });
      } catch (error) {
        if (error instanceof SlackProvisioningError)
          throw new CoreError(
            "invalid_argument",
            "Slack could not verify this code. Start again and use the new command in your Slack workspace.",
          );
        throw error;
      }
      const token = requiredSlackString(result.token);
      const teamId = requiredSlackString(result.team_id, /^T[A-Z0-9]+$/);
      const teamName = requiredSlackString(result.team_name);
      const slackUserId = requiredSlackString(result.user_id, /^[UW][A-Z0-9]+$/);
      if (result.refresh_token || result.exp)
        throw new CoreError(
          "invalid_argument",
          "Slack returned a temporary authorization. Start again to grant persistent access.",
        );
      const updated = rows(
        await db.execute(sql`UPDATE goat.slack_provisioning_attempts
        SET encrypted_payload = ${JSON.stringify(sealSlackSecret(actor.workspaceId, attemptId, { token, teamId, teamName, slackUserId }))}::jsonb
        WHERE id = ${attemptId} AND workspace_id = ${actor.workspaceId} AND user_id = ${actor.userId} AND expires_at > now() RETURNING id`),
      );
      if (!updated.length)
        throw new CoreError("invalid_argument", "This setup attempt expired. Start again.");
      return { configured: false, status: "awaiting_confirmation", teamName };
    },
    async confirm(actor: Actor, attemptId: string) {
      admin(actor);
      await db.transaction(async (tx) => {
        const [attempt] = rows<{ encrypted: EncryptedPayload; version: number }>(
          await tx.execute(sql`
          DELETE FROM goat.slack_provisioning_attempts WHERE id = ${attemptId} AND workspace_id = ${actor.workspaceId}
            AND user_id = ${actor.userId} AND consumed_at IS NOT NULL AND expires_at > now()
          RETURNING encrypted_payload AS encrypted, encryption_key_version AS version`),
        );
        if (!attempt)
          throw new CoreError(
            "invalid_argument",
            "This setup attempt expired or was already used. Start again.",
          );
        const pending = openSlackSecret(
          actor.workspaceId,
          attemptId,
          attempt.encrypted,
          attempt.version,
        );
        if (typeof pending.token !== "string")
          throw new CoreError(
            "invalid_argument",
            "Verify the Slack code before connecting this workspace.",
          );
        const token = pending.token;
        const teamId = requiredSlackString(pending.teamId);
        const teamName = requiredSlackString(pending.teamName);
        const slackUserId = requiredSlackString(pending.slackUserId);
        // Serialize setup against other admins; lock workspace even before its first connection.
        await tx.execute(
          sql`SELECT id FROM goat.workspaces WHERE id = ${actor.workspaceId} FOR UPDATE`,
        );
        const mismatches = rows(
          await tx.execute(sql`
          SELECT team_id FROM goat.slack_provisioning_connections WHERE workspace_id = ${actor.workspaceId} AND team_id <> ${teamId}
          UNION ALL SELECT external_id FROM goat.integrations WHERE workspace_id = ${actor.workspaceId} AND provider = 'slack_bot' AND status <> 'disconnected' AND external_id <> ${teamId}`),
        );
        if (mismatches.length)
          throw new CoreError(
            "conflict",
            "Use the same Slack workspace as your existing opencompany and agent identities.",
          );
        const claimed = rows(
          await tx.execute(
            sql`SELECT workspace_id FROM goat.slack_provisioning_connections WHERE team_id = ${teamId} AND workspace_id <> ${actor.workspaceId}`,
          ),
        );
        if (claimed.length)
          throw new CoreError(
            "conflict",
            "This Slack workspace is already connected to another opencompany workspace.",
          );
        await tx.execute(sql`INSERT INTO goat.slack_provisioning_connections (workspace_id, team_id, team_name, authorized_by, slack_user_id, encrypted_payload)
          VALUES (${actor.workspaceId}, ${teamId}, ${teamName}, ${actor.userId}, ${slackUserId}, ${JSON.stringify(sealSlackSecret(actor.workspaceId, "connection", { token }))}::jsonb)
          ON CONFLICT (workspace_id) DO UPDATE SET team_name = EXCLUDED.team_name, authorized_by = EXCLUDED.authorized_by, slack_user_id = EXCLUDED.slack_user_id,
            encrypted_payload = EXCLUDED.encrypted_payload, status = 'connected', updated_at = now()`);
        await tx.execute(sql`DELETE FROM goat.slack_provisioning_attempts WHERE id = ${attemptId}`);
      });
      return this.get(actor);
    },
    async disconnect(actor: Actor) {
      admin(actor);
      // Preserve workspace binding and agent installations. Stop provisioning and erase only the
      // developer credential; existing bot tokens continue to serve explicitly enabled agents.
      await db.execute(
        sql`UPDATE goat.slack_provisioning_connections SET status = 'disconnected', encrypted_payload = ${JSON.stringify(sealSlackSecret(actor.workspaceId, "connection", {}))}::jsonb, updated_at = now() WHERE workspace_id = ${actor.workspaceId}`,
      );
      await db.execute(
        sql`DELETE FROM goat.slack_provisioning_attempts WHERE workspace_id = ${actor.workspaceId}`,
      );
      return this.get(actor);
    },
  };
}
export type SlackProvisioningService = ReturnType<typeof createSlackProvisioningService>;
