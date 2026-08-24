import type { AgentModelId, CodexReasoningEffort } from "@opencompany/agent-runtime/types";

// Runtime and presentation vocabulary for retained opencompany Tasks. These are domain
// contracts, not Drizzle row types; browser adapters and the runner can share them
// without importing the database package.
export type HarnessEngine = "opencompany" | "codex" | "claude_code";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type TaskStage =
  | "queued"
  | "planning"
  | "sandboxing"
  | "running"
  | "completed"
  | "failed"
  | "canceled";
export type TaskReportedOutcome = "done" | "needs_attention";
export type TaskMessageRole = "user" | "assistant" | "tool";
export type TaskMessageStatus = "created" | "running" | "completed" | "failed";
export type TaskModelUsagePhase = "planner" | "execution";
export type TaskEventType =
  | "task.status"
  | "harness.planned"
  | "artifact.created"
  | "assistant.delta"
  | "reasoning.completed"
  | "message.created"
  | "message.completed"
  | "message.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed";

export type TaskToolName =
  | "exa_search"
  | "browser_open"
  | "browser_snapshot"
  | "browser_click"
  | "browser_fill"
  | "browser_wait"
  | "browser_read"
  | "browser_get"
  | "browser_find"
  | "browser_scroll"
  | "browser_screenshot"
  | "browser_close"
  | "x_search_posts"
  | "x_get_profile"
  | "x_get_user_posts"
  | "x_get_discussion"
  | "social_get_job"
  | "gmail_search"
  | "gmail_get_message"
  | "gmail_list_threads"
  | "gmail_get_thread"
  | "calendar_list_calendars"
  | "calendar_list_events"
  | "calendar_get_event"
  | "calendar_get_freebusy"
  | "linear_search_tools"
  | "linear_use_tool"
  | "latitude_search_tools"
  | "latitude_use_tool"
  | "github_clone_repository"
  | "github_shell"
  | "github_status"
  | "github_open_pull_request"
  | "goat_brain"
  | "save_to_brain"
  | "web_search"
  | "web_fetch"
  | "list_actions"
  | "use_action"
  | "update_task_status";

export type TaskSkillId = "first-principles" | "yc-office-hours";

export type HarnessWorkflowStep = {
  index: number;
  title: string;
  engine: HarnessEngine;
  model: AgentModelId;
  reasoningEffort?: CodexReasoningEffort;
  systemPrompt: string;
  systemBlocks: string[];
  skillIds: string[];
  skillBundleIds: string[];
};

export type HarnessSpec = {
  schemaVersion: "goat.harness.v1";
  engine: HarnessEngine;
  model: AgentModelId;
  systemPrompt: string;
  initialUserMessage: string;
  tools: TaskToolName[];
  skills: TaskSkillId[];
  maxModelSteps: number;
  resultMode: "assistant_final" | "brain_markdown_report";
  systemBlocks?: string[];
  workflow?: {
    id: string;
    workspaceId: string;
    skillIds: string[];
    skillBundleIds: string[];
    steps?: HarnessWorkflowStep[];
    currentStepIndex?: number;
    completedStepCount?: number;
    lastCompletedStepOutcome?: {
      reportedOutcome: TaskReportedOutcome | null;
      outcomeComment: string | null;
    };
  };
  codex?: {
    repository?: string | null;
    createPullRequest?: boolean;
    reasoningEffort?: CodexReasoningEffort;
    goalMode?: { objective: string; tokenBudget?: number | null };
  };
};
