export type ChatHostToolOperation =
  | "bootstrap"
  | "use_skill"
  | "read_skill_file"
  | "create_workspace_skill"
  | "start_task"
  | "schedule_task"
  | "edit_task_schedule"
  | "delete_task_schedule"
  | "start_workflow"
  | "browser_use_profile"
  | "browser_end_profile"
  | "browser"
  | "wiki";

export type ChatHostToolGatewayRequest = {
  operation: ChatHostToolOperation;
  sessionId: string;
  turnId: string;
  input?: Record<string, unknown>;
  /**
   * Stable AI-SDK tool-call id for the invocation, when the operation has one.
   * Used to build a per-tool-call idempotency key so a transport retry replays
   * the same write instead of duplicating it.
   */
  toolCallId?: string;
};

export type ChatHostSkill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
};

export type ChatHostSkillFileChunk = {
  path: string;
  executable: boolean;
  sizeBytes: number;
  offset: number;
  nextOffset: number;
  eof: boolean;
  encoding: "utf8" | "base64";
  content: string;
};

export type ChatHostBootstrap = {
  userContext: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    timezone: string;
  };
  workspaceName: string;
  taskToolsEnabled: boolean;
  skillToolsEnabled: boolean;
  wikiEnabled: boolean;
  browserToolsEnabled: boolean;
  browserProfiles: Array<{
    id: string;
    name: string;
    siteHost: string;
  }>;
  skills: Array<{ id: string; name: string; description: string }>;
  activeSkills: ChatHostSkill[];
  workflows: Array<{ id: string; name: string; description: string }>;
  recurringSchedules: Array<{
    id: string;
    name: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    nextRunAt: string;
    prompt: string;
    sourceDescription: string;
  }>;
};

export type ChatHostToolGatewayResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };
