export type GoatChatHostToolOperation =
  | "bootstrap"
  | "use_skill"
  | "start_task"
  | "schedule_task"
  | "edit_task_schedule"
  | "delete_task_schedule"
  | "start_workflow"
  | "browser_use_profile"
  | "browser_end_profile"
  | "browser"
  | "wiki";

export type GoatChatHostToolGatewayRequest = {
  operation: GoatChatHostToolOperation;
  sessionId: string;
  turnId: string;
  input?: Record<string, unknown>;
};

export type GoatChatHostSkill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
};

export type GoatChatHostBootstrap = {
  userContext: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    timezone: string;
  };
  workspaceName: string;
  taskToolsEnabled: boolean;
  wikiEnabled: boolean;
  browserToolsEnabled: boolean;
  browserProfiles: Array<{
    id: string;
    name: string;
    siteHost: string;
  }>;
  skills: Array<{ id: string; name: string; description: string }>;
  activeSkills: GoatChatHostSkill[];
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

export type GoatChatHostToolGatewayResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };
