export const GOOGLE_ADMIN_USER_SCOPE = "https://www.googleapis.com/auth/admin.directory.user";
export const GOOGLE_ADMIN_GROUP_SCOPE = "https://www.googleapis.com/auth/admin.directory.group";
export const GOOGLE_ADMIN_SCOPES = [GOOGLE_ADMIN_USER_SCOPE, GOOGLE_ADMIN_GROUP_SCOPE];
export const GOOGLE_ADMIN_MCP_RECONNECT_REASON =
  "Reconnect Google Admin with a Workspace administrator account and grant access to users and groups.";

export function googleAdminMcpScopesSatisfied(scopes: readonly string[]) {
  return GOOGLE_ADMIN_SCOPES.every((scope) => scopes.includes(scope));
}
