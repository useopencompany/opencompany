import type { CodexCommandToolInput, CodexCommandToolOutput } from "@opencompany/agent-runtime";
import type { GoatHarnessEngine } from "@opencompany/db/goat-schema";
import type { GoatCapabilityEnvelope } from "./capabilities";

export const START_TASK_TOOL_NAME = "start_task";
export const START_TASK_TOOL_PART_TYPE = `tool-${START_TASK_TOOL_NAME}` as const;
export const SCHEDULE_TASK_TOOL_NAME = "schedule_task";
export const SCHEDULE_TASK_TOOL_PART_TYPE = `tool-${SCHEDULE_TASK_TOOL_NAME}` as const;
export const EDIT_TASK_SCHEDULE_TOOL_NAME = "edit_task_schedule";
export const EDIT_TASK_SCHEDULE_TOOL_PART_TYPE = `tool-${EDIT_TASK_SCHEDULE_TOOL_NAME}` as const;
export const DELETE_TASK_SCHEDULE_TOOL_NAME = "delete_task_schedule";
export const DELETE_TASK_SCHEDULE_TOOL_PART_TYPE =
  `tool-${DELETE_TASK_SCHEDULE_TOOL_NAME}` as const;
export const GOAT_BRAIN_TOOL_NAME = "goat_brain";
export const GOAT_BRAIN_TOOL_PART_TYPE = `tool-${GOAT_BRAIN_TOOL_NAME}` as const;
export const SAVE_TO_BRAIN_TOOL_NAME = "save_to_brain";
export const SAVE_TO_BRAIN_TOOL_PART_TYPE = `tool-${SAVE_TO_BRAIN_TOOL_NAME}` as const;
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_SEARCH_TOOL_PART_TYPE = `tool-${WEB_SEARCH_TOOL_NAME}` as const;
export const USE_CAPABILITY_TOOL_NAME = "use_capability";
export const USE_CAPABILITY_TOOL_PART_TYPE = `tool-${USE_CAPABILITY_TOOL_NAME}` as const;

export type StartTaskToolInput = {
  prompt: string;
  name: string;
  engine?: GoatHarnessEngine;
  reason?: string;
};

export type StartTaskToolOutput = {
  taskId: string;
  taskDisplayId: string;
  taskName: string;
  status: "queued" | "already_started";
  prompt: string;
};

export type ScheduleTaskToolInput = {
  prompt: string;
  name: string;
  cron: string;
  timezone?: string;
  sourceDescription?: string;
  reason?: string;
};

export type ScheduleTaskToolOutput = {
  scheduleId: string;
  scheduleName: string;
  cron: string;
  timezone: string;
  nextRunAt: string;
  prompt: string;
  status: "scheduled";
};

export type EditTaskScheduleToolInput = {
  scheduleId?: string;
  scheduleName?: string;
  name?: string;
  prompt?: string;
  cron?: string;
  timezone?: string;
  sourceDescription?: string;
  reason?: string;
};

export type EditTaskScheduleToolOutput =
  | {
      ok: true;
      scheduleId: string;
      scheduleName: string;
      cron: string;
      timezone: string;
      nextRunAt: string;
      status: "updated";
    }
  | {
      ok: false;
      error: string;
      status: "not_found" | "ambiguous" | "invalid";
    };

export type DeleteTaskScheduleToolInput = {
  scheduleId?: string;
  scheduleName?: string;
  reason?: string;
};

export type DeleteTaskScheduleToolOutput =
  | {
      ok: true;
      scheduleId: string;
      scheduleName: string;
      status: "deleted";
    }
  | {
      ok: false;
      error: string;
      status: "not_found" | "ambiguous" | "invalid";
    };

export type GoatBrainCliCommand =
  | "help"
  | "create"
  | "list"
  | "get"
  | "timeline"
  | "query"
  | "append-evidence"
  | "rewrite"
  | "set"
  | "alias"
  | "timeline-add"
  | "append-timeline"
  | "link"
  | "merge"
  | "move"
  | "delete"
  | "folder"
  | "doctor";

export type GoatBrainToolFlagValue = string | number | boolean | string[];

export type GoatBrainToolInput = {
  command: GoatBrainCliCommand;
  flags?: Record<string, GoatBrainToolFlagValue>;
  stdin?: string;
};

export type GoatBrainToolOutput = {
  ok: boolean;
  brainRef?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command?: string;
  argv?: string[];
  parsed?: unknown;
  error?: string;
  traceId?: string;
  tracePath?: string;
  durationMs?: number;
};

export type SaveToBrainToolInput = {
  // Text to capture; optional when attachmentIds carry the payload.
  content?: string;
  title?: string;
  intent?: string;
  // Ids of files attached in this conversation to file as brain assets.
  attachmentIds?: string[];
};

export type SaveToBrainToolOutput =
  | {
      ok: true;
      status: "captured" | "already_captured" | "paused_by_plan";
      message?: string;
      // Text capture result (absent for attachment-only saves).
      draftId?: string;
      path?: string;
      title?: string;
      // Attachment capture results (absent for text-only saves).
      assets?: Array<{ documentId: string; path: string; title: string }>;
    }
  | {
      ok: false;
      error: string;
    };

export type WebSearchToolInput = {
  query: string;
  recencyDays?: 7 | 30 | 90;
};

export type WebSearchToolResult = {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  highlights: string[];
};

export type WebSearchToolOutput =
  | {
      ok: true;
      query: string;
      searchedAt: string;
      results: WebSearchToolResult[];
      requestId?: string;
      costUsdMicros?: number;
    }
  | {
      ok: false;
      error: string;
    };

export type UseCapabilityToolInput = {
  capability: string;
  request: string;
};

// The worker's envelope plus the capability id, so the UI can label the row
// without re-reading the input part.
export type UseCapabilityToolOutput = GoatCapabilityEnvelope & {
  capability: string;
};

export type GoatChatTools = {
  start_task: {
    input: StartTaskToolInput;
    output: StartTaskToolOutput;
  };
  schedule_task: {
    input: ScheduleTaskToolInput;
    output: ScheduleTaskToolOutput;
  };
  edit_task_schedule: {
    input: EditTaskScheduleToolInput;
    output: EditTaskScheduleToolOutput;
  };
  delete_task_schedule: {
    input: DeleteTaskScheduleToolInput;
    output: DeleteTaskScheduleToolOutput;
  };
  goat_brain: {
    input: GoatBrainToolInput;
    output: GoatBrainToolOutput;
  };
  save_to_brain: {
    input: SaveToBrainToolInput;
    output: SaveToBrainToolOutput;
  };
  web_search: {
    input: WebSearchToolInput;
    output: WebSearchToolOutput;
  };
  use_capability: {
    input: UseCapabilityToolInput;
    output: UseCapabilityToolOutput;
  };
  codex_command: {
    input: CodexCommandToolInput;
    output: CodexCommandToolOutput;
  };
};
