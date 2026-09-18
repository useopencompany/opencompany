export type ChatHostToolOperation =
  | "bootstrap"
  | "use_skill"
  | "read_skill_file"
  | "create_workspace_skill"
  | "edit_workspace_skill"
  | "workspace_skills"
  | "start_workflow"
  | "workflows"
  | "browser_use_profile"
  | "browser_end_profile"
  | "browser"
  | "wiki"
  | "write_artifact"
  // Gateway operation names are a runner/web wire contract, so this one keeps its
  // original value while the model-facing tool is SLACK_BOT_TOOL_NAME. Renaming
  // it would break every in-flight run across a partial deploy.
  | "post_slack_message";

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
  automationToolsEnabled: boolean;
  // The Slack send tool is only registered for a workflow run whose Channels section keeps Slack
  // on, so an ordinary chat never sees a tool it cannot use.
  slackChannelEnabled: boolean;
  skillToolsEnabled: boolean;
  subagentsEnabled: boolean;
  browserToolsEnabled: boolean;
  browserProfiles: Array<{
    id: string;
    name: string;
    siteHost: string;
  }>;
  skills: Array<{ id: string; name: string; description: string }>;
  activeSkills: ChatHostSkill[];
  workflows: Array<{ id: string; name: string; description: string }>;
};

export type ChatHostToolGatewayResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };
