import {
  buildAad,
  decryptJson,
  type EncryptedPayload,
  encryptJson,
  loadEncryptionKey,
} from "@opencompany/crypto";
import type { PooledDb } from "@opencompany/db/pool";
import { subscriptionRows as rows } from "@opencompany/db/session-subscriptions";
import { sql } from "drizzle-orm";
import { getAppUrl } from "../app-url";
import { SLACK_AGENT_SCOPES, slackAgentManifest } from "./slack-agent";
import { bindSlackAgent } from "./slack-agent-binding";

export function sealSlackSecret(workspaceId: string, id: string, payload: Record<string, unknown>) {
  return encryptJson(payload, {
    key: loadEncryptionKey(1),
    aad: buildAad({ purpose: "slack-provisioning", workspaceId, id }),
  });
}
export function openSlackSecret(
  workspaceId: string,
  id: string,
  payload: EncryptedPayload,
  version = 1,
) {
  return decryptJson(payload, {
    key: loadEncryptionKey(version),
    aad: buildAad({ purpose: "slack-provisioning", workspaceId, id }),
  });
}

export class SlackProvisioningError extends Error {
  constructor(readonly code: string) {
    super(`Slack setup failed (${code}).`);
  }
}
// Slack's developer tooling APIs use the CLI protocol over ordinary HTTPS. Never log responses:
// successful responses contain app credentials and errors can echo request fields.
export async function slackProvisioningRequest(
  method: string,
  body: Record<string, unknown>,
  token?: string,
  fetcher = globalThis.fetch,
): Promise<Record<string, any>> {
  const hosted = method.startsWith("apps.hosted.");
  let response: Response;
  try {
    response = await fetcher(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": hosted
          ? "application/x-www-form-urlencoded"
          : "application/json; charset=utf-8",
        "User-Agent": "slack-cli/v4.8.0 (os: linux) AI-Agent (name: opencompany)",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: hosted
        ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]))
        : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new SlackProvisioningError("request_unconfirmed");
  }
  const result = await response.json().catch(() => null);
  if (response.status >= 500) throw new SlackProvisioningError("request_unconfirmed");
  if (!response.ok || result?.ok !== true) {
    const code =
      typeof result?.error === "string" && /^[a-z_]{1,80}$/.test(result.error)
        ? result.error
        : "request_unconfirmed";
    throw new SlackProvisioningError(code);
  }
  return result;
}
export type ProvisioningRequest = typeof slackProvisioningRequest;
export function requiredSlackString(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value)))
    throw new SlackProvisioningError("invalid_response");
  return value;
}
export function provisioningReason(code: string) {
  if (["invalid_auth", "token_revoked", "token_expired", "account_inactive"].includes(code))
    return "Slack authorization expired or was revoked. Ask an admin to reconnect in Settings → Channels → Slack.";
  if (code === "https_endpoint_required")
    return "Slack needs a public HTTPS connection to this deployment. Ask your administrator to check its API and app URLs, then retry.";
  if (code.startsWith("app_approval"))
    return "Your Slack workspace requires app approval. Open the app in Slack to request approval, then retry.";
  if (["request_unconfirmed", "invalid_response"].includes(code))
    return "Slack did not confirm the request. Check the app in Slack before trying again.";
  return `Slack could not finish setup (${code}). Retry after resolving this in Slack.`;
}

type Job = {
  agentId: string;
  workspaceId: string;
  teamId: string;
  appId: string | null;
  state: string;
  secret: EncryptedPayload | null;
  keyVersion: number;
  connectionSecret: EncryptedPayload;
  connectionVersion: number;
  name: string;
  photoUrl: string;
  ownerId: string;
  profile: string;
};

export async function processNextSlackProvisioning(input: {
  db: PooledDb;
  apiOrigin: string;
  request?: ProvisioningRequest;
  bind?: typeof bindSlackAgent;
}): Promise<boolean> {
  const { db } = input;
  const request = input.request ?? slackProvisioningRequest;
  await db.execute(sql`UPDATE goat.slack_provisioning_connections c SET status = 'needs_reauth', updated_at = now()
    WHERE c.status = 'connected' AND NOT EXISTS (SELECT 1 FROM goat.workspace_members m WHERE m.workspace_id = c.workspace_id AND m.user_workos_id = c.authorized_by AND m.role = 'admin')`);
  // Discover desired state from the saved agent, including writes outside the web editor.
  await db.execute(sql`
    INSERT INTO goat.slack_agent_provisioning (agent_id, workspace_id, team_id)
    SELECT w.id, w.workspace_id, c.team_id FROM goat.workflows w
    JOIN goat.slack_provisioning_connections c ON c.workspace_id = w.workspace_id AND c.status = 'connected'
    JOIN goat.workspace_members m ON m.workspace_id = w.workspace_id AND m.user_workos_id = w.owner_workos_id
    WHERE w.kind = 'agent' AND w.slack_channel_enabled AND w.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM goat.integrations i WHERE i.company_agent_id = w.id)
    ON CONFLICT (agent_id) DO NOTHING`);
  // An interrupted create cannot be retried safely: Slack has no create idempotency key.
  await db.execute(sql`UPDATE goat.slack_agent_provisioning SET state = 'uncertain', reason = 'Slack app creation was interrupted. Ask an admin to check Slack before creating another identity.', lease_until = NULL
    WHERE state = 'creating' AND lease_until < now()`);
  const job = await db.transaction(async (tx) => {
    const [selected] = rows<Job>(
      await tx.execute(sql`
      SELECT j.agent_id AS "agentId", j.workspace_id AS "workspaceId", j.team_id AS "teamId", j.app_id AS "appId", j.state,
        j.encrypted_payload AS secret, j.encryption_key_version AS "keyVersion",
        c.encrypted_payload AS "connectionSecret", c.encryption_key_version AS "connectionVersion",
        w.name, COALESCE(w.slack_bot_avatar_url, '') AS "photoUrl", w.owner_workos_id AS "ownerId",
        jsonb_build_array(w.name, COALESCE(w.slack_bot_avatar_url, ''))::text AS profile
      FROM goat.slack_agent_provisioning j JOIN goat.workflows w ON w.id = j.agent_id
      JOIN goat.slack_provisioning_connections c ON c.workspace_id = j.workspace_id AND c.team_id = j.team_id AND c.status = 'connected'
      JOIN goat.workspace_members m ON m.workspace_id = w.workspace_id AND m.user_workos_id = w.owner_workos_id
      WHERE w.archived_at IS NULL AND w.slack_channel_enabled AND (j.lease_until IS NULL OR j.lease_until < now())
        AND (j.state IN ('queued', 'created', 'installed') OR (j.state = 'ready' AND j.profile_hash IS DISTINCT FROM jsonb_build_array(w.name, COALESCE(w.slack_bot_avatar_url, ''))::text))
      ORDER BY j.updated_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`),
    );
    if (!selected) return null;
    await tx.execute(
      sql`UPDATE goat.slack_agent_provisioning SET lease_until = now() + interval '2 minutes', state = ${selected.state === "queued" ? "creating" : selected.state}, updated_at = now() WHERE agent_id = ${selected.agentId}`,
    );
    return selected;
  });
  if (!job) return false;
  try {
    if (
      new URL(input.apiOrigin).protocol !== "https:" ||
      (!job.photoUrl && new URL(getAppUrl()).protocol !== "https:")
    )
      throw new SlackProvisioningError("https_endpoint_required");
    const token = requiredSlackString(
      openSlackSecret(job.workspaceId, "connection", job.connectionSecret, job.connectionVersion)
        .token,
    );
    let secrets = job.secret
      ? openSlackSecret(job.workspaceId, job.agentId, job.secret, job.keyVersion)
      : {};
    if (job.state === "queued") {
      const result = await request(
        "apps.manifest.create",
        { manifest: slackAgentManifest({ name: job.name }) },
        token,
      );
      const appId = requiredSlackString(result.app_id, /^A[A-Z0-9]+$/);
      if (result.team_id !== job.teamId) throw new SlackProvisioningError("workspace_mismatch");
      const signingSecret = requiredSlackString(
        result.credentials?.signing_secret,
        /^[a-f0-9]{32}$/i,
      );
      secrets = { signingSecret };
      await db.execute(
        sql`UPDATE goat.slack_agent_provisioning SET app_id = ${appId}, state = 'created', encrypted_payload = ${JSON.stringify(sealSlackSecret(job.workspaceId, job.agentId, secrets))}::jsonb, lease_until = NULL, updated_at = now() WHERE agent_id = ${job.agentId}`,
      );
    } else if (job.state === "created") {
      const installed = await request(
        "apps.developerInstall",
        { app_id: job.appId, bot_scopes: SLACK_AGENT_SCOPES },
        token,
      );
      if (installed.app_id !== job.appId || installed.team_id !== job.teamId)
        throw new SlackProvisioningError("workspace_mismatch");
      const botToken = requiredSlackString(installed.api_access_tokens?.bot, /^xoxb-/);
      await (input.bind ?? bindSlackAgent)({
        db,
        actor: {
          userId: job.ownerId,
          workspaceId: job.workspaceId,
          role: "member",
          permissions: [],
          authenticationMethod: "service",
        },
        agent: { id: job.agentId, name: job.name },
        credentials: { botToken, signingSecret: requiredSlackString(secrets.signingSecret) },
      });
      await db.execute(
        sql`UPDATE goat.slack_agent_provisioning SET state = 'installed', lease_until = NULL, updated_at = now() WHERE agent_id = ${job.agentId}`,
      );
    } else {
      const eventsUrl = new URL(
        `/webhooks/slack-agents/${encodeURIComponent(job.agentId)}/events`,
        input.apiOrigin,
      ).toString();
      if (!eventsUrl.startsWith("https://"))
        throw new SlackProvisioningError("https_endpoint_required");
      await request(
        "apps.manifest.update",
        { app_id: job.appId, manifest: slackAgentManifest({ name: job.name, eventsUrl }) },
        token,
      );
      await request(
        "apps.icon.set",
        {
          app_id: job.appId,
          url: job.photoUrl || new URL("/icon/company-agent.png", getAppUrl()).toString(),
        },
        token,
      );
      await db.execute(
        sql`UPDATE goat.slack_agent_provisioning SET state = 'ready', reason = NULL, profile_hash = ${job.profile}, lease_until = NULL, updated_at = now() WHERE agent_id = ${job.agentId}`,
      );
    }
  } catch (error) {
    const code = error instanceof SlackProvisioningError ? error.code : "setup_failed";
    const uncertain =
      job.state === "queued" &&
      [
        "request_unconfirmed",
        "invalid_response",
        "workspace_mismatch",
        "setup_failed",
        "internal_error",
        "fatal_error",
      ].includes(code);
    await db.execute(
      sql`UPDATE goat.slack_agent_provisioning SET state = ${uncertain ? "uncertain" : "failed"}, reason = ${provisioningReason(code)}, lease_until = NULL, updated_at = now() WHERE agent_id = ${job.agentId}`,
    );
    if (["invalid_auth", "token_revoked", "token_expired", "account_inactive"].includes(code))
      await db.execute(
        sql`UPDATE goat.slack_provisioning_connections SET status = 'needs_reauth', updated_at = now() WHERE workspace_id = ${job.workspaceId}`,
      );
  }
  return true;
}
