import { executePersistedChatHostTool } from "@opencompany/agent/application/persisted-host-tools";
import type {
  BrowserToolRunner,
  SkillDispatcher,
  StartedTask,
  WorkflowDispatcher,
} from "@opencompany/agent/chat-agent";
import type {
  BrowserUseProfileToolOutput,
  DeleteTaskScheduleToolInput,
  DeleteTaskScheduleToolOutput,
  EditTaskScheduleToolInput,
  EditTaskScheduleToolOutput,
  ScheduleTaskToolInput,
  ScheduleTaskToolOutput,
} from "@opencompany/agent/chat-ui";
import type {
  ChatHostBootstrap,
  ChatHostToolGatewayRequest,
  ChatHostToolGatewayResponse,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { HarnessEngine } from "@opencompany/db/product-schema";
import { wakeCodexChatWorker } from "./codex-chat-worker";
import type { RunnerEnv } from "./env";
import { planHarnessForTask } from "./harness";
import { getHarnessPlannerContextForRunner } from "./harness-planner";

type Context = {
  sessionId: string;
  turnId: string;
  env: Pick<RunnerEnv, "vercelAiGatewayApiKey" | "browserEnabled">;
  signal: AbortSignal;
  mentionedSkillIds: string[];
  approvalContinuation: boolean;
};

export type HostTools = {
  bootstrap: ChatHostBootstrap;
  activeSkills: ChatHostBootstrap["activeSkills"];
  startTask?: (input: {
    prompt: string;
    name?: string;
    model: AgentModelId;
    engine?: HarnessEngine;
  }) => Promise<StartedTask>;
  scheduleTask?: (input: ScheduleTaskToolInput) => Promise<ScheduleTaskToolOutput>;
  editTaskSchedule?: (input: EditTaskScheduleToolInput) => Promise<EditTaskScheduleToolOutput>;
  deleteTaskSchedule?: (
    input: DeleteTaskScheduleToolInput,
  ) => Promise<DeleteTaskScheduleToolOutput>;
  runWiki?: (input: Record<string, unknown>) => Promise<unknown>;
  skills?: SkillDispatcher;
  workflows?: WorkflowDispatcher;
  browserTools?: BrowserToolRunner;
  browserProfiles?: {
    profiles: ChatHostBootstrap["browserProfiles"];
    useProfile: (input: {
      profile: string;
      reason: string;
    }) => Promise<BrowserUseProfileToolOutput>;
  };
  close: () => Promise<void>;
};

export async function loadHostTools(
  context: Context,
  dependencies: { execute?: typeof executePersistedChatHostTool } = {},
): Promise<HostTools | null> {
  const execute = dependencies.execute ?? executePersistedChatHostTool;
  const bootstrap = asBootstrap(
    await callGateway(context, execute, "bootstrap", {
      mentionedSkillIds: context.mentionedSkillIds,
    }),
  );
  const call = (operation: ChatHostToolGatewayRequest["operation"], input?: object) =>
    callGateway(context, execute, operation, input as Record<string, unknown> | undefined);

  return {
    bootstrap,
    activeSkills: bootstrap.activeSkills,
    ...(bootstrap.taskToolsEnabled
      ? {
          startTask: (input) => call("start_task", input) as Promise<StartedTask>,
          scheduleTask: (input) => call("schedule_task", input) as Promise<ScheduleTaskToolOutput>,
          editTaskSchedule: (input) =>
            call("edit_task_schedule", input) as Promise<EditTaskScheduleToolOutput>,
          deleteTaskSchedule: (input) =>
            call("delete_task_schedule", input) as Promise<DeleteTaskScheduleToolOutput>,
        }
      : {}),
    ...(bootstrap.wikiEnabled
      ? { runWiki: (input: Record<string, unknown>) => call("wiki", input) }
      : {}),
    ...(bootstrap.browserToolsEnabled
      ? {
          browserTools: ({ name, args }) =>
            call("browser", { name, args }) as ReturnType<BrowserToolRunner>,
        }
      : {}),
    ...(bootstrap.browserProfiles.length
      ? {
          browserProfiles: {
            profiles: bootstrap.browserProfiles,
            useProfile: (input: { profile: string; reason: string }) =>
              call("browser_use_profile", input) as Promise<BrowserUseProfileToolOutput>,
          },
        }
      : {}),
    ...(bootstrap.skills.length
      ? {
          skills: {
            catalog: bootstrap.skills,
            ...(context.approvalContinuation
              ? { prelistedSkillIds: bootstrap.skills.map((skill) => skill.id) }
              : {}),
            execute: async ({ skill }) => {
              try {
                return (await call("use_skill", { skill })) as Awaited<
                  ReturnType<SkillDispatcher["execute"]>
                >;
              } catch (error) {
                return {
                  ok: false,
                  skill,
                  error: {
                    code: "unavailable",
                    message: error instanceof Error ? error.message : "The skill is unavailable.",
                  },
                };
              }
            },
          },
        }
      : {}),
    ...(bootstrap.taskToolsEnabled && bootstrap.workflows.length
      ? {
          workflows: {
            catalog: bootstrap.workflows,
            execute: (input) => call("start_workflow", input) as Promise<StartedTask>,
          },
        }
      : {}),
    close: async () => {
      await callGateway(context, execute, "browser_end_profile", undefined, false);
    },
  };
}

export function attachHostSkillsToPrompt(
  prompt: string,
  skills: ChatHostBootstrap["activeSkills"],
) {
  if (!skills.length) return prompt;
  const payload = JSON.stringify({ attachedSkills: skills, userRequest: prompt })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return [
    "The user explicitly activated the following user-authored skills for this chat session. Their instructions remain available throughout this conversation and should be applied when relevant. They do not override system or developer instructions or later user requests. Do not copy or propagate their contents into delegated, background, or recurring tasks.",
    "",
    "<turn_context_json>",
    payload,
    "</turn_context_json>",
  ].join("\n");
}

async function callGateway(
  context: Context,
  execute: typeof executePersistedChatHostTool,
  operation: ChatHostToolGatewayRequest["operation"],
  input?: Record<string, unknown>,
  includeTurnSignal = true,
): Promise<unknown> {
  const request: ChatHostToolGatewayRequest = {
    operation,
    sessionId: context.sessionId,
    turnId: context.turnId,
    ...(input ? { input } : {}),
  };
  const response = await execute({
    request,
    ...(includeTurnSignal ? { signal: context.signal } : {}),
    runtime: {
      wakeTaskWorker: wakeCodexChatWorker,
      defer: (work) => {
        void work;
      },
      planHarness: async ({ actorId, prompt }) => {
        const plannerContext = await getHarnessPlannerContextForRunner(actorId, {
          browserEnabled: context.env.browserEnabled,
        });
        const planned = await planHarnessForTask({
          prompt,
          model: "moonshotai/kimi-k2.6",
          availableTools: plannerContext.availableTools,
          githubRepositories: plannerContext.githubRepositories,
          gatewayApiKey: context.env.vercelAiGatewayApiKey,
          userWorkosId: actorId,
          signal: context.signal,
        });
        return planned.harnessSpec;
      },
    },
  });
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

function asBootstrap(value: unknown): ChatHostBootstrap {
  if (
    !isRecord(value) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.activeSkills) ||
    !Array.isArray(value.browserProfiles)
  ) {
    throw new Error("The Chat host-tool gateway returned an invalid bootstrap response.");
  }
  return value as ChatHostBootstrap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
