import type { RuntimeToolName } from "@opencompany/agent-runtime";
import type { GoatTaskToolName } from "@opencompany/db/goat-schema";
import { GOAT_SPANS, recordGoatToolCall, startGoatSpan } from "@opencompany/goat-observability";
import { jsonSchema, type ToolSet, tool } from "ai";
import type { RunnerEnv } from "./env";
import {
  createGoatGitHubToolSession,
  type GoatGitHubSandboxUsage,
  type GoatGitHubToolName,
  isGoatGitHubToolName,
} from "./goat-github-tools";
import {
  executeGoatGoogleTool,
  type GoatGoogleToolName,
  isGoatGoogleToolName,
} from "./goat-google-tools";
import {
  executeGoatLinearMcpTool,
  type GoatLinearMcpToolName,
  isGoatLinearMcpToolName,
} from "./goat-linear-mcp-tools";
import { executeHostedTool, type HostedToolUsage } from "./hosted-tools";

export const GOAT_TASK_TOOL_NAMES = [
  "exa_search",
  "gmail_search",
  "gmail_get_message",
  "gmail_list_threads",
  "gmail_get_thread",
  "calendar_list_calendars",
  "calendar_list_events",
  "calendar_get_event",
  "calendar_get_freebusy",
  "linear_search_tools",
  "linear_use_tool",
  "github_clone_repository",
  "github_shell",
  "github_status",
  "github_open_pull_request",
] as const satisfies readonly GoatTaskToolName[];

const GOAT_TASK_TOOL_SET = new Set<GoatTaskToolName>(GOAT_TASK_TOOL_NAMES);

export type GoatToolLifecycleInput = {
  toolCallId: string;
  toolName: GoatTaskToolName;
  input: unknown;
};

export type GoatToolLifecycleCompletion = GoatToolLifecycleInput & {
  output: unknown;
  usage?: HostedToolUsage;
};

export type GoatToolLifecycleFailure = GoatToolLifecycleInput & {
  error: string;
};

export type GoatToolLifecycle = {
  onToolStarted?: (input: GoatToolLifecycleInput) => Promise<{ messageId: string } | void>;
  onToolCompleted?: (input: GoatToolLifecycleCompletion & { messageId?: string }) => Promise<void>;
  onToolFailed?: (input: GoatToolLifecycleFailure & { messageId?: string }) => Promise<void>;
};

export type GoatTaskToolsInput = {
  selectedTools: readonly GoatTaskToolName[];
  userWorkosId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  lifecycle?: GoatToolLifecycle;
  recordSandboxUsage?: (usage: GoatGitHubSandboxUsage) => Promise<void>;
};

export type GoatTaskToolRuntime = {
  tools: ToolSet;
  cleanup: () => Promise<void>;
};

export function normalizeGoatTaskToolNames(value: unknown): GoatTaskToolName[] {
  const selected = new Set<GoatTaskToolName>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && GOAT_TASK_TOOL_SET.has(item as GoatTaskToolName)) {
        selected.add(item as GoatTaskToolName);
      }
    }
  }
  if (selected.size === 0) {
    selected.add("exa_search");
  }
  return GOAT_TASK_TOOL_NAMES.filter((name) => selected.has(name));
}

export function buildGoatTaskTools(input: GoatTaskToolsInput): ToolSet {
  return buildGoatTaskToolRuntime(input).tools;
}

export function buildGoatTaskToolRuntime(input: GoatTaskToolsInput): GoatTaskToolRuntime {
  const githubSession = createGoatGitHubToolSession({
    userWorkosId: input.userWorkosId,
    env: input.env,
    signal: input.signal,
    ...(input.recordSandboxUsage ? { recordSandboxUsage: input.recordSandboxUsage } : {}),
  });
  return {
    tools: buildGoatTaskToolsForSession(input, githubSession),
    cleanup: () => githubSession.cleanup(),
  };
}

function buildGoatTaskToolsForSession(
  input: GoatTaskToolsInput,
  githubSession: ReturnType<typeof createGoatGitHubToolSession>,
): ToolSet {
  const tools: ToolSet = {};
  const selected = new Set(normalizeGoatTaskToolNames(input.selectedTools));
  const messageIdsByCallId = new Map<string, string>();

  const startTool = async (toolName: GoatTaskToolName, toolInput: unknown, toolCallId: string) => {
    const result = await input.lifecycle?.onToolStarted?.({
      toolCallId,
      toolName,
      input: toolInput,
    });
    if (result?.messageId) messageIdsByCallId.set(toolCallId, result.messageId);
  };

  const completeTool = async (
    toolName: GoatTaskToolName,
    toolInput: unknown,
    toolCallId: string,
    output: unknown,
    usage: HostedToolUsage | undefined,
  ) => {
    const messageId = messageIdsByCallId.get(toolCallId);
    await input.lifecycle?.onToolCompleted?.({
      toolCallId,
      toolName,
      input: toolInput,
      output,
      ...(usage ? { usage } : {}),
      ...(messageId ? { messageId } : {}),
    });
  };

  const failTool = async (
    toolName: GoatTaskToolName,
    toolInput: unknown,
    toolCallId: string,
    error: string,
  ) => {
    const messageId = messageIdsByCallId.get(toolCallId);
    await input.lifecycle?.onToolFailed?.({
      toolCallId,
      toolName,
      input: toolInput,
      error,
      ...(messageId ? { messageId } : {}),
    });
  };

  for (const toolName of selected) {
    tools[toolName] = tool({
      description: goatToolDescription(toolName),
      inputSchema: jsonSchema(goatToolInputSchema(toolName) as never),
      onInputAvailable: async ({
        input: toolInput,
        toolCallId,
      }: {
        input: unknown;
        toolCallId: string;
      }) => {
        assertNotAborted(input.signal);
        await startTool(toolName, toolInput, toolCallId);
      },
      execute: async (toolInput: unknown, options: { toolCallId: string }) => {
        assertNotAborted(input.signal);
        const startedAt = performance.now();
        const attributes = {
          "goat.tool_name": toolName,
        };
        const span = startGoatSpan(GOAT_SPANS.taskToolCall, attributes);
        try {
          const result = await executeGoatTaskTool({
            toolName,
            toolInput,
            userWorkosId: input.userWorkosId,
            env: input.env,
            signal: input.signal,
            toolCallId: options.toolCallId,
            messageId: messageIdsByCallId.get(options.toolCallId) ?? null,
            githubSession,
          });
          await completeTool(toolName, toolInput, options.toolCallId, result.output, result.usage);
          span.end({
            ...attributes,
            "goat.outcome": "success",
          });
          recordGoatToolCall({
            durationMs: Math.round(performance.now() - startedAt),
            outcome: "success",
            attributes,
          });
          return result.output;
        } catch (error) {
          if (input.signal.aborted) {
            span.end({
              ...attributes,
              "goat.outcome": "aborted",
            });
            recordGoatToolCall({
              durationMs: Math.round(performance.now() - startedAt),
              outcome: "aborted",
              attributes,
            });
            throw error;
          }
          const message = errorMessage(error);
          await failTool(toolName, toolInput, options.toolCallId, message);
          const failureCategory = span.fail(error, attributes);
          span.end({
            ...attributes,
            "goat.outcome": "failure",
            "goat.failure_category": failureCategory,
          });
          recordGoatToolCall({
            durationMs: Math.round(performance.now() - startedAt),
            outcome: "failure",
            attributes: {
              ...attributes,
              "goat.failure_category": failureCategory,
            },
          });
          return { ok: false, error: message };
        }
      },
    } as never) as ToolSet[string];
  }

  return tools;
}

async function executeGoatTaskTool(input: {
  toolName: GoatTaskToolName;
  toolInput: unknown;
  userWorkosId: string;
  env: RunnerEnv;
  signal: AbortSignal;
  toolCallId: string;
  messageId?: string | null;
  githubSession: ReturnType<typeof createGoatGitHubToolSession>;
}): Promise<{ output: unknown; usage?: HostedToolUsage }> {
  if (input.toolName === "exa_search") {
    return executeExaSearch({
      args: input.toolInput,
      env: input.env,
      signal: input.signal,
    });
  }
  if (isGoatGoogleToolName(input.toolName)) {
    const output = await executeGoatGoogleTool({
      name: input.toolName as GoatGoogleToolName,
      args: input.toolInput,
      userWorkosId: input.userWorkosId,
      env: input.env,
      signal: input.signal,
    });
    return { output, usage: zeroCostToolUsage(input.toolName, input.toolName) };
  }
  if (isGoatLinearMcpToolName(input.toolName)) {
    const output = await executeGoatLinearMcpTool({
      name: input.toolName as GoatLinearMcpToolName,
      args: input.toolInput,
      userWorkosId: input.userWorkosId,
      signal: input.signal,
    });
    return {
      output,
      usage: zeroCostToolUsage(input.toolName, linearOperation(input.toolName, input.toolInput)),
    };
  }
  if (isGoatGitHubToolName(input.toolName)) {
    const output = await input.githubSession.execute({
      name: input.toolName as GoatGitHubToolName,
      toolInput: input.toolInput,
      toolCallId: input.toolCallId,
      messageId: input.messageId ?? null,
    });
    return {
      output,
      usage: zeroCostToolUsage(input.toolName, githubOperation(input.toolName)),
    };
  }
  return {
    output: { ok: false, error: `Unknown Goat tool "${input.toolName}".` },
    usage: zeroCostToolUsage(input.toolName, input.toolName),
  };
}

async function executeExaSearch(input: { args: unknown; env: RunnerEnv; signal: AbortSignal }) {
  const args = asRecord(input.args);
  const query = readString(args, "query");
  const hosted = await executeHostedTool({
    name: "exa_search" as RuntimeToolName,
    args: input.args,
    env: input.env,
    enabledTools: ["exa_search" as RuntimeToolName],
    signal: input.signal,
  });
  return {
    output: {
      ok: true,
      query,
      results: compactHostedExaResults(hosted.output),
    },
    ...(hosted.usage ? { usage: hosted.usage } : {}),
  };
}

function compactHostedExaResults(output: unknown) {
  const record = asRecord(output);
  const results = Array.isArray(record.results) ? record.results : [];
  return results.map(compactExaResult);
}

function compactExaResult(value: unknown) {
  const record = asRecord(value);
  return {
    title: readString(record, "title"),
    url: readString(record, "url"),
    publishedDate: readString(record, "publishedDate"),
    author: readString(record, "author"),
    text: truncate(readString(record, "text"), 2_000),
    highlights: Array.isArray(record.highlights)
      ? record.highlights
          .filter((item): item is string => typeof item === "string")
          .map((item) => truncate(item, 600))
          .slice(0, 5)
      : [],
  };
}

function goatToolDescription(toolName: GoatTaskToolName) {
  switch (toolName) {
    case "exa_search":
      return "Search the web with Exa and return concise source results.";
    case "gmail_search":
      return "Search connected Gmail with Gmail query syntax and return message ids, snippets, and headers. Read-only.";
    case "gmail_get_message":
      return "Fetch one connected Gmail message by id, including headers, snippet, labels, and decoded plain text. Read-only.";
    case "gmail_list_threads":
      return "List connected Gmail threads, optionally filtered by Gmail query syntax. Read-only.";
    case "gmail_get_thread":
      return "Fetch a connected Gmail thread by id, including each message's headers and decoded plain text. Read-only.";
    case "calendar_list_calendars":
      return "List calendars visible to the connected Google Calendar account. Read-only.";
    case "calendar_list_events":
      return "List Google Calendar events for a calendar and optional time range. Read-only.";
    case "calendar_get_event":
      return "Fetch one Google Calendar event by calendar id and event id. Read-only.";
    case "calendar_get_freebusy":
      return "Check free/busy blocks for connected Google calendars. Read-only.";
    case "linear_search_tools":
      return "List available Linear MCP tools, including names, descriptions, and input schemas. Call this before linear_use_tool.";
    case "linear_use_tool":
      return "Run one Linear MCP tool by exact name from linear_search_tools. Only create or update Linear records when the user explicitly asked for that action.";
    case "github_clone_repository":
      return "Clone one connected GitHub repository into an ephemeral task sandbox. Call this before github_shell, github_status, or github_open_pull_request.";
    case "github_shell":
      return "Run a broad noninteractive shell command from the cloned GitHub repository directory. Use this for git, gh, package managers, tests, and project scripts.";
    case "github_status":
      return "Inspect the cloned GitHub repository branch, status, diff stat, and diff preview.";
    case "github_open_pull_request":
      return "Commit current repository changes, push a branch, and open a GitHub pull request. Use only when the user explicitly asked to publish or open a PR.";
  }
}

function goatToolInputSchema(toolName: GoatTaskToolName) {
  switch (toolName) {
    case "exa_search":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          numResults: { type: "number", minimum: 1, maximum: 10 },
          type: {
            type: "string",
            enum: ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"],
          },
        },
        required: ["query"],
      } as const;
    case "gmail_search":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          maxResults: { type: "number", minimum: 1, maximum: 50 },
          account: { type: "string" },
        },
        required: ["query"],
      } as const;
    case "gmail_get_message":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          messageId: { type: "string" },
          account: { type: "string" },
        },
        required: ["messageId"],
      } as const;
    case "gmail_list_threads":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          maxResults: { type: "number", minimum: 1, maximum: 50 },
          account: { type: "string" },
        },
      } as const;
    case "gmail_get_thread":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          threadId: { type: "string" },
          account: { type: "string" },
        },
        required: ["threadId"],
      } as const;
    case "calendar_list_calendars":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          account: { type: "string" },
        },
      } as const;
    case "calendar_list_events":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          calendarId: { type: "string" },
          timeMin: { type: "string" },
          timeMax: { type: "string" },
          query: { type: "string" },
          maxResults: { type: "number", minimum: 1, maximum: 50 },
          account: { type: "string" },
        },
      } as const;
    case "calendar_get_event":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          calendarId: { type: "string" },
          eventId: { type: "string" },
          account: { type: "string" },
        },
        required: ["eventId"],
      } as const;
    case "calendar_get_freebusy":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          timeMin: { type: "string" },
          timeMax: { type: "string" },
          calendarIds: { type: "array", items: { type: "string" } },
          account: { type: "string" },
        },
        required: ["timeMin", "timeMax"],
      } as const;
    case "linear_search_tools":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
        },
      } as const;
    case "linear_use_tool":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          tool: { type: "string" },
          arguments: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["tool"],
      } as const;
    case "github_clone_repository":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          repository: { type: "string" },
          ref: { type: "string" },
        },
        required: ["repository"],
      } as const;
    case "github_shell":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number", minimum: 1000, maximum: 600000 },
        },
        required: ["command"],
      } as const;
    case "github_status":
      return {
        type: "object",
        additionalProperties: false,
        properties: {},
      } as const;
    case "github_open_pull_request":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          branchName: { type: "string" },
          commitMessage: { type: "string" },
          draft: { type: "boolean" },
        },
        required: ["title"],
      } as const;
  }
}

function zeroCostToolUsage(toolName: GoatTaskToolName, operation: string): HostedToolUsage {
  return {
    provider: goatToolProvider(toolName),
    operation,
    costUsdMicros: 0,
    costSource: "subscription",
    rawUsage: {
      display_only: true,
      toolName,
      operation,
    },
  };
}

function goatToolProvider(toolName: GoatTaskToolName) {
  if (toolName.startsWith("gmail_")) return "gmail";
  if (toolName.startsWith("calendar_")) return "google_calendar";
  if (toolName.startsWith("linear_")) return "linear";
  if (toolName.startsWith("github_")) return "github";
  if (toolName === "exa_search") return "exa";
  return "goat";
}

function linearOperation(toolName: GoatTaskToolName, toolInput: unknown) {
  if (toolName !== "linear_use_tool") return toolName;
  return readString(asRecord(toolInput), "tool") || toolName;
}

function githubOperation(toolName: GoatTaskToolName) {
  return toolName.replace(/^github_/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Goat task was aborted.");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Goat tool error.";
}
