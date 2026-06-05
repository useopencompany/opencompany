import { getDb } from "@opencompany/db/client";
import { workspaceIntegrationResources, workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { saveIntegrationCredential } from "@/lib/integrations/credential-storage";
import type {
  GoogleCalendarSummary,
  GoogleIntegrationProvider,
  GoogleOAuthTokens,
} from "@/lib/integrations/google-oauth";

export const GOOGLE_CALENDAR_RESOURCE_TYPE = "calendar";

export type ConnectGoogleIntegrationInput = {
  provider: GoogleIntegrationProvider;
  workspaceId: string;
  connectedByUserId: string;
  /** Stable Google account id (OpenID `sub`). One row per (workspace, provider, account). */
  externalId: string;
  accountEmail: string | null;
  accountName: string | null;
  tokens: GoogleOAuthTokens;
  expiresAt: Date | null;
  /** Calendars discovered for this account; only provided for the calendar provider. */
  calendars?: GoogleCalendarSummary[];
};

/**
 * Upsert a connected Google account (Gmail or Calendar) plus its encrypted OAuth tokens, and —
 * for Calendar — sync the account's calendar list as selectable resources. Mirrors
 * `syncGitHubIntegrationRepositories` so the rest of the integrations stack treats Google the
 * same as GitHub.
 */
export async function connectGoogleIntegration(input: ConnectGoogleIntegrationInput) {
  const db = getDb();
  const now = new Date();
  const connectionLabel = input.accountEmail?.trim() || input.accountName?.trim() || "Google";

  const [integration] = await db
    .insert(workspaceIntegrations)
    .values({
      id: newWorkspaceIntegrationId(),
      workspaceId: input.workspaceId,
      provider: input.provider,
      externalId: input.externalId,
      connectionLabel,
      accountName: input.accountName,
      accountEmail: input.accountEmail,
      accountType: "google_account",
      connectedByUserId: input.connectedByUserId,
      status: "connected",
      statusReason: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        workspaceIntegrations.workspaceId,
        workspaceIntegrations.provider,
        workspaceIntegrations.externalId,
      ],
      set: {
        connectionLabel,
        accountName: input.accountName,
        accountEmail: input.accountEmail,
        accountType: "google_account",
        connectedByUserId: input.connectedByUserId,
        status: "connected",
        statusReason: null,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: workspaceIntegrations.id });

  if (!integration) {
    throw new Error("Could not persist Google integration.");
  }

  // The integration row is upserted as "connected" above, but the connection is only usable once
  // its encrypted tokens (and, for Calendar, its calendar list) are persisted. If either write
  // fails, demote the row to "sync_failed" so the UI doesn't advertise a broken connection, then
  // rethrow so the caller can surface the error.
  try {
    await saveIntegrationCredential({
      workspaceId: input.workspaceId,
      integrationId: integration.id,
      provider: input.provider,
      kind: "oauth_token",
      payload: { ...input.tokens },
      expiresAt: input.expiresAt,
      db,
      now,
    });

    if (input.calendars) {
      await syncCalendarResources({
        db,
        now,
        workspaceId: input.workspaceId,
        provider: input.provider,
        integrationId: integration.id,
        calendars: input.calendars,
      });
    }
  } catch (error) {
    await db
      .update(workspaceIntegrations)
      .set({
        status: "sync_failed",
        statusReason: "Failed to persist Google integration credentials.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceIntegrations.id, integration.id),
          eq(workspaceIntegrations.workspaceId, input.workspaceId),
          eq(workspaceIntegrations.provider, input.provider),
        ),
      );
    throw error;
  }

  return { integrationId: integration.id };
}

export async function disconnectGoogleIntegration(input: {
  workspaceId: string;
  provider: GoogleIntegrationProvider;
  integrationId: string;
}) {
  // Credentials and resources cascade-delete via their composite FK to the integration row.
  await getDb()
    .delete(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.provider, input.provider),
        eq(workspaceIntegrations.id, input.integrationId),
      ),
    );
}

async function syncCalendarResources(input: {
  db: ReturnType<typeof getDb>;
  now: Date;
  workspaceId: string;
  provider: GoogleIntegrationProvider;
  integrationId: string;
  calendars: GoogleCalendarSummary[];
}) {
  const { db, now } = input;

  const resourceValues = input.calendars.map((calendar) => ({
    id: newWorkspaceIntegrationResourceId(),
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    provider: input.provider,
    resourceType: GOOGLE_CALENDAR_RESOURCE_TYPE,
    externalId: calendar.id,
    name: calendar.summary,
    displayName: calendar.summary,
    status: "available" as const,
    statusReason: null,
    lastSyncedAt: now,
    // Primary calendars are exposed to agents by default; others are opt-in via the UI.
    selectedAt: calendar.primary ? now : null,
    metadata: {
      primary: calendar.primary,
      accessRole: calendar.accessRole ?? null,
      backgroundColor: calendar.backgroundColor ?? null,
    },
    updatedAt: now,
  }));

  if (resourceValues.length > 0) {
    await db
      .insert(workspaceIntegrationResources)
      .values(resourceValues)
      .onConflictDoUpdate({
        target: [
          workspaceIntegrationResources.integrationId,
          workspaceIntegrationResources.resourceType,
          workspaceIntegrationResources.externalId,
        ],
        set: {
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          provider: input.provider,
          resourceType: GOOGLE_CALENDAR_RESOURCE_TYPE,
          name: sql`excluded.name`,
          displayName: sql`excluded.display_name`,
          status: "available",
          statusReason: null,
          lastSyncedAt: now,
          // Preserve the user's existing selection across re-syncs.
          metadata: sql`excluded.metadata`,
          updatedAt: now,
        },
      });
  }

  // Calendars the account can no longer see are kept (so a re-share restores them) but flagged.
  const staleUpdate = {
    status: "permission_lost" as const,
    statusReason: "Calendar is no longer visible to the connected Google account.",
    lastSyncedAt: now,
    updatedAt: now,
  };
  const baseStaleFilter = and(
    eq(workspaceIntegrationResources.integrationId, input.integrationId),
    eq(workspaceIntegrationResources.workspaceId, input.workspaceId),
    eq(workspaceIntegrationResources.provider, input.provider),
    eq(workspaceIntegrationResources.resourceType, GOOGLE_CALENDAR_RESOURCE_TYPE),
  );

  await db
    .update(workspaceIntegrationResources)
    .set(staleUpdate)
    .where(
      input.calendars.length > 0
        ? and(
            baseStaleFilter,
            notInArray(
              workspaceIntegrationResources.externalId,
              input.calendars.map((calendar) => calendar.id),
            ),
          )
        : baseStaleFilter,
    );
}

function newWorkspaceIntegrationId() {
  return `wint_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function newWorkspaceIntegrationResourceId() {
  return `wres_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
