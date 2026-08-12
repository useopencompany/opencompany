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
export const TASK_READ_PERMISSION = "task:read";
export const TASK_WRITE_PERMISSION = "task:write";
export const WORKFLOW_READ_PERMISSION = "workflow:read";
export const WORKFLOW_WRITE_PERMISSION = "workflow:write";
export const SCHEDULE_READ_PERMISSION = "schedule:read";
export const SCHEDULE_WRITE_PERMISSION = "schedule:write";

export function actorHasPermission(actor: Actor, permission: string): boolean {
  return actor.permissions.includes(permission);
}
