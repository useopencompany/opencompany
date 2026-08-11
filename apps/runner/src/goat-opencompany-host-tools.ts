import type {
  GoatChatHostBootstrap,
  GoatChatHostToolGatewayRequest,
  GoatChatHostToolGatewayResponse,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { GoatHarnessEngine } from "@opencompany/db/goat-schema";
import { executePersistedGoatChatHostTool } from "@opencompany/goat-agent/application/persisted-host-tools";
import type {
  BrowserToolRunner,
  SkillDispatcher,
  StartedTask,
  WorkflowDispatcher,
} from "@opencompany/goat-agent/chat-agent";
import type {
  BrowserUseProfileToolOutput,
  DeleteTaskScheduleToolInput,
  DeleteTaskScheduleToolOutput,
  EditTaskScheduleToolInput,
  EditTaskScheduleToolOutput,
  ScheduleTaskToolInput,
  ScheduleTaskToolOutput,
} from "@opencompany/goat-agent/chat-ui";
import type { RunnerEnv } from "./env";
import { wakeGoatCodexChatWorker } from "./goat-codex-chat-worker";
import { planGoatHarnessForTask } from "./goat-harness";
import { getGoatHarnessPlannerContextForRunner } from "./goat-harness-planner";

type Context = {
  sessionId: string;
  turnId: string;
  env: Pick<RunnerEnv, "vercelAiGatewayApiKey" | "goatBrowserEnabled">;
  signal: AbortSignal;
  mentionedSkillIds: string[];
  approvalContinuation: boolean;
};

export type GoatOpenCompanyHostTools = {
  bootstrap: GoatChatHostBootstrap;
  activeSkills: GoatChatHostBootstrap["activeSkills"];
  startTask?: (input: {
    prompt: string;
    name?: string;
    model: AgentModelId;
    engine?: GoatHarnessEngine;
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
    profiles: GoatChatHostBootstrap["browserProfiles"];
    useProfile: (input: {
      profile: string;
      reason: string;
    }) => Promise<BrowserUseProfileToolOutput>;
  };
  close: () => Promise<void>;
};

export async function loadGoatOpenCompanyHostTools(
  context: Context,
  dependencies: { execute?: typeof executePersistedGoatChatHostTool } = {},
): Promise<GoatOpenCompanyHostTools | null> {
  const execute = dependencies.execute ?? executePersistedGoatChatHostTool;
  const bootstrap = asBootstrap(
    await callGateway(context, execute, "bootstrap", {
      mentionedSkillIds: context.mentionedSkillIds,
    }),
  );
  const call = (operation: GoatChatHostToolGatewayRequest["operation"], input?: object) =>
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

export function attachGoatHostSkillsToPrompt(
  prompt: string,
  skills: GoatChatHostBootstrap["activeSkills"],
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
  execute: typeof executePersistedGoatChatHostTool,
  operation: GoatChatHostToolGatewayRequest["operation"],
  input?: Record<string, unknown>,
  includeTurnSignal = true,
): Promise<unknown> {
  const request: GoatChatHostToolGatewayRequest = {
    operation,
    sessionId: context.sessionId,
    turnId: context.turnId,
    ...(input ? { input } : {}),
  };
  const response = await execute({
    request,
    ...(includeTurnSignal ? { signal: context.signal } : {}),
    runtime: {
      wakeTaskWorker: wakeGoatCodexChatWorker,
      defer: (work) => {
        void work;
      },
      planHarness: async ({ actorId, prompt }) => {
        const plannerContext = await getGoatHarnessPlannerContextForRunner(actorId, {
          browserEnabled: context.env.goatBrowserEnabled,
        });
        const planned = await planGoatHarnessForTask({
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

function asBootstrap(value: unknown): GoatChatHostBootstrap {
  if (
    !isRecord(value) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.activeSkills) ||
    !Array.isArray(value.browserProfiles)
  ) {
    throw new Error("The Chat host-tool gateway returned an invalid bootstrap response.");
  }
  return value as GoatChatHostBootstrap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
