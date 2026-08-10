export type AuthenticationMethod = "session" | "oauth" | "api_key" | "service";

export type Actor = {
  userId: string;
  workspaceId: string;
  sessionId?: string;
  role: string;
  permissions: readonly string[];
  authenticationMethod: AuthenticationMethod;
};

export const CHAT_READ_PERMISSION = "chat:read";
export const CHAT_WRITE_PERMISSION = "chat:write";

export function actorHasPermission(actor: Actor, permission: string): boolean {
  return actor.permissions.includes(permission);
}
