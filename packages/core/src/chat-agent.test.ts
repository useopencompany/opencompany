import { CODEX_DEFAULT_MODEL_ID } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenCompanyChatToolContext,
  OPENCOMPANY_CHAT_MAX_STEPS,
  prepareOpenCompanyChatStep,
  UPDATE_TASK_STATUS_TOOL_NAME,
} from "./chat-agent";
import { START_TASK_TOOL_NAME, START_WORKFLOW_TOOL_NAME } from "./chat-ui";

const model = "moonshotai/kimi-k2.6" as never;

describe("start_task tool", () => {
  it.each([
    "moonshotai/kimi-k3",
    "xai/grok-4.3",
    "anthropic/claude-sonnet-5",
  ])("normalizes a Codex task from %s main chat to the default Codex model", async (mainModel) => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Test repo access",
      prompt: task.prompt,
    }));
    const context = createOpenCompanyChatToolContext({
      model: mainModel as never,
      requestedEngine: "codex",
      startTask,
    });
    const startTaskTool = context.tools[START_TASK_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };

    await startTaskTool.execute({
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
      reason: "Requires connected source-control access.",
    });

    expect(startTask).toHaveBeenCalledWith({
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
      model: CODEX_DEFAULT_MODEL_ID,
      engine: "codex",
    });
  });

  it("preserves an already Codex-compatible task model", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Test repo access",
      prompt: task.prompt,
    }));
    const context = createOpenCompanyChatToolContext({
      model: "openai/gpt-5.5" as never,
      requestedEngine: "codex",
      startTask,
    });
    const startTaskTool = context.tools[START_TASK_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };

    await startTaskTool.execute({
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
    });

    expect(startTask).toHaveBeenCalledWith({
      name: "Test repo access",
      prompt: "Check repo access and report whether development work can start.",
      model: "openai/gpt-5.5",
      engine: "codex",
    });
  });
});

describe("update_task_status tool gating", () => {
  it("is absent when no updateTaskStatus runner is injected (interactive chat / Slack)", () => {
    const context = createOpenCompanyChatToolContext({ model });
    expect(UPDATE_TASK_STATUS_TOOL_NAME in context.tools).toBe(false);
  });

  it("is present only when an updateTaskStatus runner is explicitly injected", async () => {
    const calls: Array<{ status: string; comment: string }> = [];
    const context = createOpenCompanyChatToolContext({
      model,
      updateTaskStatus: async ({ status, comment }) => {
        calls.push({ status, comment });
      },
    });
    expect(UPDATE_TASK_STATUS_TOOL_NAME in context.tools).toBe(true);

    const tool = context.tools[UPDATE_TASK_STATUS_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };
    const result = await tool.execute({
      status: "needs_attention",
      comment: "  Blocked on auth.  ",
    });
    expect(result).toEqual({
      ok: true,
      status: "needs_attention",
      comment: "Blocked on auth.",
    });
    expect(calls).toEqual([{ status: "needs_attention", comment: "Blocked on auth." }]);
  });
});

describe("start_workflow tool", () => {
  const workflowCatalog = [
    {
      id: "customer-interview-synthesis",
      name: "Customer interview synthesis",
      description: "Synthesize confirmed interview findings.",
    },
  ];

  it("is available only when an active workflow dispatcher is injected", () => {
    const absent = createOpenCompanyChatToolContext({ model });
    const empty = createOpenCompanyChatToolContext({
      model,
      workflows: {
        catalog: [],
        execute: async () => {
          throw new Error("should not run");
        },
      },
    });
    const available = createOpenCompanyChatToolContext({
      model,
      workflows: {
        catalog: workflowCatalog,
        execute: async () => ({
          id: "task_1",
          displayId: "TASK-1",
          name: "Customer interview synthesis",
          prompt: "Synthesize the Acme interview.",
        }),
      },
    });

    expect(START_WORKFLOW_TOOL_NAME in absent.tools).toBe(false);
    expect(START_WORKFLOW_TOOL_NAME in empty.tools).toBe(false);
    expect(START_WORKFLOW_TOOL_NAME in available.tools).toBe(true);
  });

  it("starts an exact active workflow and returns the standard task-card output", async () => {
    const calls: unknown[] = [];
    const context = createOpenCompanyChatToolContext({
      model,
      workflows: {
        catalog: workflowCatalog,
        execute: async (input) => {
          calls.push(input);
          return {
            id: "task_1",
            displayId: "TASK-1",
            name: "Customer interview synthesis",
            prompt: input.prompt,
          };
        },
      },
    });
    const workflowTool = context.tools[START_WORKFLOW_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };

    await expect(
      workflowTool.execute({
        workflowId: "customer-interview-synthesis",
        prompt: "  Synthesize the Acme interview using the confirmed pricing concern.  ",
      }),
    ).resolves.toEqual({
      taskId: "task_1",
      taskDisplayId: "TASK-1",
      taskName: "Customer interview synthesis",
      status: "queued",
      prompt: "Synthesize the Acme interview using the confirmed pricing concern.",
    });
    expect(calls).toEqual([
      {
        workflowId: "customer-interview-synthesis",
        prompt: "Synthesize the Acme interview using the confirmed pricing concern.",
      },
    ]);
    expect(context.getStartedTask()?.id).toBe("task_1");
  });

  it("rejects workflow ids outside the injected workspace catalog", async () => {
    const execute = vi.fn();
    const context = createOpenCompanyChatToolContext({
      model,
      workflows: {
        catalog: workflowCatalog,
        execute,
      },
    });
    const workflowTool = context.tools[START_WORKFLOW_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };

    await expect(
      workflowTool.execute({
        workflowId: "other-workspace-workflow",
        prompt: "Run it.",
      }),
    ).rejects.toThrow("not an active workflow in this workspace");
    expect(execute).not.toHaveBeenCalled();
  });

  it("shares the one-task-per-turn guard with start_task", async () => {
    let releaseTask!: (task: {
      id: string;
      displayId: string;
      name: string;
      prompt: string;
    }) => void;
    const taskInFlight = new Promise<{
      id: string;
      displayId: string;
      name: string;
      prompt: string;
    }>((resolve) => {
      releaseTask = resolve;
    });
    const workflowExecute = vi.fn();
    const context = createOpenCompanyChatToolContext({
      model,
      startTask: async () => taskInFlight,
      workflows: {
        catalog: workflowCatalog,
        execute: workflowExecute,
      },
    });
    const startTask = context.tools[START_TASK_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };
    const startWorkflow = context.tools[START_WORKFLOW_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };

    const taskResult = startTask.execute({ name: "Research market", prompt: "Research market." });
    const workflowResult = startWorkflow.execute({
      workflowId: "customer-interview-synthesis",
      prompt: "Synthesize the interview.",
    });
    releaseTask({
      id: "task_1",
      displayId: "TASK-1",
      name: "Research market",
      prompt: "Research market.",
    });

    await expect(taskResult).resolves.toMatchObject({ taskId: "task_1", status: "queued" });
    await expect(workflowResult).resolves.toMatchObject({
      taskId: "task_1",
      status: "already_started",
    });
    expect(workflowExecute).not.toHaveBeenCalled();
  });
});

describe("prepareOpenCompanyChatStep maxSteps", () => {
  it("reserves the final step with the default chat budget", () => {
    expect(prepareOpenCompanyChatStep({ stepNumber: OPENCOMPANY_CHAT_MAX_STEPS - 2 })).toEqual({});
    expect(prepareOpenCompanyChatStep({ stepNumber: OPENCOMPANY_CHAT_MAX_STEPS - 1 })).toEqual({
      activeTools: [],
      toolChoice: "none",
    });
  });

  it("reserves the final step at a task's larger budget", () => {
    expect(prepareOpenCompanyChatStep({ stepNumber: 14, maxSteps: 16 })).toEqual({});
    expect(prepareOpenCompanyChatStep({ stepNumber: 15, maxSteps: 16 })).toEqual({
      activeTools: [],
      toolChoice: "none",
    });
  });

  it("does not force a paid action on a resumed approval step", () => {
    expect(
      prepareOpenCompanyChatStep({
        stepNumber: 0,
        forceApprovedAction: true,
      } as Parameters<typeof prepareOpenCompanyChatStep>[0] & {
        forceApprovedAction: boolean;
      }),
    ).toEqual({});
  });
});
