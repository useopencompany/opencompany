import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns, type SQL, sql } from "drizzle-orm";
import { getDb } from "./client";
import { saveIntegrationCredential } from "./integrations";
import { integrations, sentryConnections } from "./product-schema";

type DbLike = any;
export type SentryConnection = {
  integrationId: string;
  workspaceId: string;
  installationId: string;
  organizationId: string;
  organizationSlug: string;
  region: "us" | "eu";
  selectedProjectIds: string[];
  cooldownMinutes: number;
  dailyCap: number;
  verifiedAt: Date | null;
  lastReceivedAt: Date | null;
  userWorkosId: string;
  status: "connected" | "disconnected" | "needs_reauth" | "sync_failed";
  capabilityModes: Record<string, "on" | "ask" | "off">;
  toolModes: Record<string, "on" | "ask" | "off">;
};
export function sentryRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return (value as { rows?: T[] })?.rows ?? [];
}
export async function getSentryConnection(
  workspaceId: string,
  db: DbLike = getDb(),
): Promise<SentryConnection | null> {
  const [row] = await db
    .select({
      ...getTableColumns(sentryConnections),
      userWorkosId: integrations.userWorkosId,
      status: integrations.status,
      capabilityModes: integrations.capabilityModes,
      toolModes: integrations.toolModes,
    })
    .from(sentryConnections)
    .innerJoin(integrations, eq(integrations.id, sentryConnections.integrationId))
    .where(eq(sentryConnections.workspaceId, workspaceId))
    .limit(1);
  return row ?? null;
}
export async function findSentryInstallation(
  installationId: string,
  db: DbLike = getDb(),
): Promise<SentryConnection | null> {
  installationId = installationId.toLowerCase();
  const [row] = await db
    .select({ workspaceId: sentryConnections.workspaceId })
    .from(sentryConnections)
    .where(eq(sentryConnections.installationId, installationId));
  return row ? getSentryConnection(row.workspaceId, db) : null;
}

// Locking by installation also protects the credential exchange/binding against two workspaces.
// Unique indexes remain the final guard even if callers run in different processes.
export async function bindSentryConnection(input: {
  workspaceId: string;
  userWorkosId: string;
  installationId: string;
  organizationId: string;
  organizationSlug: string;
  region: "us" | "eu";
  token: string;
  refreshToken: string;
  expiresAt: Date;
  db?: DbLike;
}): Promise<SentryConnection> {
  input = { ...input, installationId: input.installationId.toLowerCase() };
  const db = input.db ?? getDb();
  return db.transaction(async (tx: DbLike) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`sentry-install:${input.installationId}`}))`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`sentry-workspace:${input.workspaceId}`}))`,
    );
    const [owner] = await tx
      .select({
        id: integrations.id,
        userWorkosId: integrations.userWorkosId,
        workspaceId: integrations.workspaceId,
        updatedAt: integrations.updatedAt,
      })
      .from(integrations)
      .where(
        and(eq(integrations.provider, "sentry"), eq(integrations.externalId, input.installationId)),
      )
      .limit(1);
    if (owner && owner.workspaceId !== input.workspaceId)
      throw new Error("This Sentry installation belongs to another workspace.");
    const existing = await findSentryInstallation(input.installationId, tx);
    if (existing && existing.workspaceId !== input.workspaceId)
      throw new Error("This Sentry installation belongs to another workspace.");
    const current = await getSentryConnection(input.workspaceId, tx);
    if (current && current.installationId !== input.installationId) {
      await tx.execute(
        sql`SELECT integration_id FROM goat.sentry_connections WHERE integration_id = ${current.integrationId} FOR UPDATE`,
      );
      const latest = await getSentryConnection(input.workspaceId, tx);
      if (latest?.status !== "disconnected")
        throw new Error("Disconnect the current Sentry organization before connecting another.");
      await tx
        .delete(sentryConnections)
        .where(eq(sentryConnections.integrationId, current.integrationId));
    }
    const integrationId =
      existing?.integrationId ?? owner?.id ?? `gint_${randomUUID().replaceAll("-", "")}`;
    const connector = existing?.userWorkosId ?? owner?.userWorkosId ?? input.userWorkosId;
    await tx
      .insert(integrations)
      .values({
        id: integrationId,
        userWorkosId: connector,
        workspaceId: input.workspaceId,
        provider: "sentry",
        externalId: input.installationId,
        accountName: input.organizationSlug,
        status: "sync_failed",
        statusReason: "Complete project selection to verify this installation.",
        scopes: [
          "org:read",
          "project:read",
          "event:read",
          "event:write",
          "member:read",
          "team:read",
        ],
      })
      .onConflictDoUpdate({
        target: integrations.id,
        set: {
          accountName: input.organizationSlug,
          status: "sync_failed",
          statusReason: "Complete project selection to verify this installation.",
          updatedAt: new Date(),
        },
      });
    await tx
      .insert(sentryConnections)
      .values({
        integrationId,
        workspaceId: input.workspaceId,
        installationId: input.installationId,
        organizationId: input.organizationId,
        organizationSlug: input.organizationSlug,
        region: input.region,
        revokedAt: owner?.updatedAt ?? null,
      })
      .onConflictDoUpdate({
        target: sentryConnections.integrationId,
        set: {
          organizationId: input.organizationId,
          organizationSlug: input.organizationSlug,
          region: input.region,
          verifiedAt: null,
        },
      });
    await saveIntegrationCredential({
      userWorkosId: connector,
      integrationId,
      provider: "sentry",
      kind: "oauth_token",
      payload: { access_token: input.token, refresh_token: input.refreshToken },
      expiresAt: input.expiresAt,
      db: tx,
    });
    return (await getSentryConnection(input.workspaceId, tx))!;
  });
}
export async function disconnectSentry(installationId: string, db: DbLike = getDb()) {
  // Serialize with admission. Once this commits no queued delivery can create a Task.
  await db.transaction(async (tx: DbLike) => {
    const connection = await findSentryInstallation(installationId, tx);
    if (!connection) return;
    await tx.execute(
      sql`SELECT integration_id FROM goat.sentry_connections WHERE integration_id = ${connection.integrationId} FOR UPDATE`,
    );
    await tx
      .update(sentryConnections)
      .set({ revokedAt: sql`clock_timestamp()` })
      .where(eq(sentryConnections.integrationId, connection.integrationId));
    await tx
      .update(integrations)
      .set({
        status: "disconnected",
        statusReason: "Sentry installation disconnected.",
        updatedAt: new Date(),
      })
      .where(
        and(eq(integrations.id, connection.integrationId), eq(integrations.provider, "sentry")),
      );
    // The worker records suppression when it claims pending deliveries. Updating them here
    // would invert the worker's event-then-connection lock order and could deadlock.
  });
}

export type SentrySqlTransaction = { execute(query: SQL): Promise<unknown> };
// Called in the Task creation transaction. The connection lock serializes admission for the entire
// workspace, making active-run checks, cooldown and the UTC daily count atomic with Task creation.
export async function admitSentryTask(
  tx: SentrySqlTransaction,
  eventId: string,
  now: Date,
): Promise<string | null> {
  const [run] = sentryRows<{
    integrationId: string;
    workspaceId: string;
    workflowId: string;
    issueId: string;
    projectId: string;
    triggerFilters: unknown;
  }>(
    await tx.execute(
      sql`SELECT integration_id AS "integrationId", workspace_id AS "workspaceId", workflow_id AS "workflowId", issue_id AS "issueId", project_id AS "projectId", trigger_filters AS "triggerFilters" FROM goat.sentry_issue_runs WHERE event_run_id = ${eventId}`,
    ),
  );
  if (!run) return "missing Sentry delivery association";
  await tx.execute(
    sql`SELECT integration_id FROM goat.sentry_connections WHERE integration_id = ${run.integrationId} FOR UPDATE`,
  );
  const [connection] = sentryRows<{
    dailyCap: number;
    cooldownMinutes: number;
    status: string;
    projects: string[];
    verified: Date | null;
    revokedAt: Date | null;
  }>(
    await tx.execute(
      sql`SELECT settings.daily_cap AS "dailyCap", settings.cooldown_minutes AS "cooldownMinutes", integration.status, settings.selected_project_ids AS projects, settings.verified_at AS verified, settings.revoked_at AS "revokedAt" FROM goat.sentry_connections settings JOIN goat.integrations integration ON integration.id = settings.integration_id WHERE settings.integration_id = ${run.integrationId}`,
    ),
  );
  if (!connection?.verified || connection.status !== "connected") return "disconnected account";
  if (connection.revokedAt) {
    const [receipt] = sentryRows<{ revoked: boolean }>(
      await tx.execute(
        sql`SELECT receipt.received_at <= ${connection.revokedAt} AS revoked FROM goat.sentry_webhook_receipts receipt JOIN goat.sentry_issue_runs run ON run.receipt_id = receipt.id WHERE run.event_run_id = ${eventId}`,
      ),
    );
    if (receipt?.revoked) return "delivery revoked by disconnection";
  }
  if (!connection.projects.includes(run.projectId)) return "project access revoked";
  const [eligible] = sentryRows<{ id: string }>(
    await tx.execute(
      sql`SELECT workflow.id FROM goat.workflows workflow JOIN goat.workflow_event_runs event ON event.workflow_id = workflow.id CROSS JOIN LATERAL jsonb_array_elements(workflow.automation_triggers) trigger(value) JOIN goat.workspace_members member ON member.workspace_id = workflow.workspace_id AND member.user_workos_id = event.user_workos_id WHERE event.id = ${eventId} AND workflow.status = 'active' AND workflow.archived_at IS NULL AND trigger.value->>'id' = event.trigger_id AND trigger.value->>'integrationId' = ${run.integrationId} AND trigger.value->>'userWorkosId' = event.user_workos_id AND trigger.value->>'provider' = 'sentry' AND trigger.value->>'event' = event.event_type AND trigger.value->'filters' = ${JSON.stringify(run.triggerFilters)}::jsonb AND event.event_at >= (trigger.value->>'activatedAt')::timestamptz FOR SHARE OF workflow, member`,
    ),
  );
  if (!eligible) return "workflow or membership revoked";
  const [active] = sentryRows<{ id: string }>(
    await tx.execute(
      sql`SELECT run.event_run_id AS id FROM goat.sentry_issue_runs run JOIN goat.workflow_event_runs event ON event.id = run.event_run_id LEFT JOIN goat.tasks task ON task.id = run.task_id WHERE run.workspace_id = ${run.workspaceId} AND run.workflow_id = ${run.workflowId} AND run.issue_id = ${run.issueId} AND run.event_run_id <> ${eventId} AND (task.status IN ('queued','running','waiting') OR (event.status = 'pending' AND (event.created_at, event.id) < (SELECT created_at, id FROM goat.workflow_event_runs WHERE id = ${eventId}))) LIMIT 1`,
    ),
  );
  if (active) return "active investigation";
  const [cooldown] = sentryRows<{ id: string }>(
    await tx.execute(
      sql`SELECT run.event_run_id AS id FROM goat.sentry_issue_runs run JOIN goat.workflow_event_runs event ON event.id = ${eventId} WHERE event.event_type <> 'issue.regressed' AND run.workspace_id = ${run.workspaceId} AND run.workflow_id = ${run.workflowId} AND run.issue_id = ${run.issueId} AND run.started_at > ${new Date(now.getTime() - connection.cooldownMinutes * 60_000)} LIMIT 1`,
    ),
  );
  if (cooldown) return "cooldown";
  const [usage] = sentryRows<{ count: number }>(
    await tx.execute(
      sql`SELECT count(*)::int AS count FROM goat.sentry_issue_runs WHERE workspace_id = ${run.workspaceId} AND started_at >= ${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))} AND started_at < ${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))}`,
    ),
  );
  if ((usage?.count ?? 0) >= connection.dailyCap) return "daily cap";
  return null;
}
