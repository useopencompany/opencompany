import type { ConnectorPermissionScope } from "@opencompany/db/schema";

export const CONNECTOR_LINEAR_PERMISSION_SCOPES = [
  "linear.issues.read",
  "linear.issues.write",
] as const satisfies readonly ConnectorPermissionScope[];

export type ConnectorLinearPermissionScope = (typeof CONNECTOR_LINEAR_PERMISSION_SCOPES)[number];

export type ConnectorLinearPermissions = Record<ConnectorLinearPermissionScope, boolean>;

export const DEFAULT_CONNECTOR_LINEAR_PERMISSIONS: ConnectorLinearPermissions = {
  "linear.issues.read": true,
  "linear.issues.write": false,
};

export const CONNECTOR_LINEAR_PERMISSION_LABELS: Record<ConnectorLinearPermissionScope, string> = {
  "linear.issues.read": "Read issues",
  "linear.issues.write": "Create + update issues",
};

export function permissionsFromRows(
  rows: Array<{ scope: string; granted: boolean }>,
): ConnectorLinearPermissions {
  const permissions = { ...DEFAULT_CONNECTOR_LINEAR_PERMISSIONS };
  for (const row of rows) {
    if (isConnectorLinearPermissionScope(row.scope)) {
      permissions[row.scope] = row.granted;
    }
  }
  return permissions;
}

export function parsePermissionsFormData(formData: FormData): ConnectorLinearPermissions {
  return {
    "linear.issues.read": formData.has("linear.issues.read"),
    "linear.issues.write": formData.has("linear.issues.write"),
  };
}

export function isConnectorLinearPermissionScope(
  value: string,
): value is ConnectorLinearPermissionScope {
  return CONNECTOR_LINEAR_PERMISSION_SCOPES.includes(value as ConnectorLinearPermissionScope);
}
