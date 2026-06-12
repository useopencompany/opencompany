import { getDb } from "@opencompany/db/client";
import { workspaceIntegrationResources, workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";
import {
  GOOGLE_PROVIDER_CONFIG,
  type GoogleIntegrationProvider,
  isGoogleIntegrationConfigured,
} from "@/lib/integrations/google-oauth";
import { GOOGLE_CALENDAR_RESOURCE_TYPE } from "@/lib/integrations/google-service";
import { googleStatus, type WorkspaceIntegrationStatus } from "@/lib/integrations/status";

export type GoogleCalendarResourceState = {
  externalId: string;
  name: string;
  primary: boolean;
  status: "available" | "permission_lost" | "archived" | "sync_failed";
  statusReason: string | null;
  selectedAt: string | null;
};

export type GoogleConnectionState = {
  id: string;
  provider: GoogleIntegrationProvider;
  accountEmail: string | null;
  accountName: string | null;
  connectionLabel: string;
  connectedByUserId: string | null;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected";
  statusReason: string | null;
  updatedAt: string;
  /** Empty for Gmail; the account's calendars for Google Calendar. */
  calendars: GoogleCalendarResourceState[];
};

export type GoogleProviderState = {
  status: WorkspaceIntegrationStatus;
  configured: boolean;
  connections: GoogleConnectionState[];
};

export type GoogleIntegrationState = {
  gmail: GoogleProviderState;
  google_calendar: GoogleProviderState;
};

const GOOGLE_PROVIDERS: GoogleIntegrationProvider[] = ["gmail", "google_calendar"];

export async function loadGoogleIntegrationState(): Promise<GoogleIntegrationState> {
  const { workspace } = await currentWorkspace();
  return loadGoogleIntegrationStateForWorkspace(workspace.id);
}

export async function loadGoogleIntegrationStateForWorkspace(
  workspaceId: string,
): Promise<GoogleIntegrationState> {
  const db = getDb();
  const configured = isGoogleIntegrationConfigured();

  const connections = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        inArray(workspaceIntegrations.provider, GOOGLE_PROVIDERS),
      ),
    )
    .orderBy(workspaceIntegrations.accountEmail, workspaceIntegrations.createdAt);

  const calendarIntegrationIds = connections
    .filter((connection) => connection.provider === "google_calendar")
    .map((connection) => connection.id);

  const calendars = calendarIntegrationIds.length
    ? await db
        .select()
        .from(workspaceIntegrationResources)
        .where(
          and(
            eq(workspaceIntegrationResources.workspaceId, workspaceId),
            eq(workspaceIntegrationResources.provider, "google_calendar"),
            eq(workspaceIntegrationResources.resourceType, GOOGLE_CALENDAR_RESOURCE_TYPE),
            inArray(workspaceIntegrationResources.integrationId, calendarIntegrationIds),
          ),
        )
    : [];

  const calendarsByIntegrationId = new Map<string, GoogleCalendarResourceState[]>();
  for (const calendar of calendars) {
    const existing = calendarsByIntegrationId.get(calendar.integrationId) ?? [];
    existing.push({
      externalId: calendar.externalId,
      name: calendar.name,
      primary: readCalendarPrimary(calendar.metadata),
      status: calendar.status,
      statusReason: calendar.statusReason,
      selectedAt: calendar.selectedAt?.toISOString() ?? null,
    });
    calendarsByIntegrationId.set(calendar.integrationId, existing);
  }

  const buildProviderState = (provider: GoogleIntegrationProvider): GoogleProviderState => {
    const providerConnections = connections
      .filter((connection) => connection.provider === provider)
      .map(
        (connection): GoogleConnectionState => ({
          id: connection.id,
          provider,
          accountEmail: connection.accountEmail,
          accountName: connection.accountName,
          connectionLabel:
            connection.connectionLabel ??
            connection.accountEmail ??
            GOOGLE_PROVIDER_CONFIG[provider].displayName,
          connectedByUserId: connection.connectedByUserId,
          status: connection.status,
          statusReason: connection.statusReason,
          updatedAt: (connection.lastSyncedAt ?? connection.updatedAt).toISOString(),
          calendars: (calendarsByIntegrationId.get(connection.id) ?? []).sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
        }),
      );

    return {
      configured,
      status: googleStatus({
        configured,
        connectionStatuses: providerConnections.map((connection) => connection.status),
      }),
      connections: providerConnections,
    };
  };

  return {
    gmail: buildProviderState("gmail"),
    google_calendar: buildProviderState("google_calendar"),
  };
}

function readCalendarPrimary(metadata: Record<string, unknown>) {
  return metadata.primary === true;
}
