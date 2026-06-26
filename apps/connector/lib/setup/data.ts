import { getDb } from "@opencompany/db/client";
import { connectorPermissionGrants } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { type ConnectorOrganization, loadConnectorOrganizationForUser } from "@/lib/auth";
import {
  type ConnectorLinearMcpSettings,
  emptyLinearMcpSettings,
  loadConnectorLinearMcpSettings,
} from "@/lib/mcp/data";
import {
  type ConnectorLinearPermissions,
  DEFAULT_CONNECTOR_LINEAR_PERMISSIONS,
  permissionsFromRows,
} from "@/lib/permissions";

export type SerializedConnectorOrganization = {
  id: string;
  name: string;
  slug: string;
  setupCompletedAt: string | null;
};

export type ConnectorSetupState = {
  organization: SerializedConnectorOrganization | null;
  linear: ConnectorLinearMcpSettings;
  permissions: ConnectorLinearPermissions;
};

export async function loadConnectorSetupState(userId: string): Promise<ConnectorSetupState> {
  const context = await loadConnectorOrganizationForUser(userId);
  if (!context) {
    return {
      organization: null,
      linear: emptyLinearMcpSettings(),
      permissions: { ...DEFAULT_CONNECTOR_LINEAR_PERMISSIONS },
    };
  }

  const [linear, permissions] = await Promise.all([
    loadConnectorLinearMcpSettings(context.organization.id),
    loadConnectorLinearPermissions(context.organization.id),
  ]);

  return {
    organization: serializeConnectorOrganization(context.organization),
    linear,
    permissions,
  };
}

export async function loadConnectorLinearPermissions(
  organizationId: string,
): Promise<ConnectorLinearPermissions> {
  const rows = await getDb()
    .select({
      scope: connectorPermissionGrants.scope,
      granted: connectorPermissionGrants.granted,
    })
    .from(connectorPermissionGrants)
    .where(
      and(
        eq(connectorPermissionGrants.organizationId, organizationId),
        eq(connectorPermissionGrants.provider, "linear"),
      ),
    );

  return permissionsFromRows(rows);
}

export function serializeConnectorOrganization(
  organization: ConnectorOrganization,
): SerializedConnectorOrganization {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    setupCompletedAt: organization.setupCompletedAt?.toISOString() ?? null,
  };
}
