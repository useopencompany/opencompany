import { CLAUDE_CODE_DEFAULT_MODEL_ID, CODEX_DEFAULT_MODEL_ID } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_MAX_STEPS,
  createProductChatToolContext,
  prepareProductChatStep,
  UPDATE_TASK_STATUS_TOOL_NAME,
} from "./chat-agent";
import {
  CREATE_WORKSPACE_SKILL_TOOL_NAME,
  EDIT_WORKSPACE_SKILL_TOOL_NAME,
  START_TASK_TOOL_NAME,
  START_WORKFLOW_TOOL_NAME,
} from "./chat-ui";

const model = "moonshotai/kimi-k2.6" as never;

describe("create_workspace_skill tool", () => {
  it("is available only when the authenticated host injects its runner", () => {
    expect(CREATE_WORKSPACE_SKILL_TOOL_NAME in createProductChatToolContext({ model }).tools).toBe(
      false,
    );
    expect(
      CREATE_WORKSPACE_SKILL_TOOL_NAME in
        createProductChatToolContext({ model, createWorkspaceSkill: vi.fn() }).tools,
    ).toBe(true);
  });

  it("passes the synthesized Skill and stable SDK tool-call id to the host", async () => {
    const createWorkspaceSkill = vi.fn(async () => ({
      created: true as const,
      name: "customer-health-review",
      command: "/customer-health-review",
      bundleId: "skill_bundle_1",
    }));
    const context = createProductChatToolContext({ model, createWorkspaceSkill });
    const skillTool = context.tools[CREATE_WORKSPACE_SKILL_TOOL_NAME] as {
      description: string;
      execute: (args: unknown, context: { toolCallId: string }) => Promise<unknown>;
    };

    await expect(
      skillTool.execute(
        {
          name: " customer-health-review ",
          description: " Review customer health. ",
          instructions: " Review the account signals. ",
        },
        { toolCallId: "call_skill_1" },
      ),
    ).resolves.toMatchObject({ created: true, command: "/customer-health-review" });

    expect(skillTool.description).toContain("latest message explicitly asks");
    expect(createWorkspaceSkill).toHaveBeenCalledWith(
      {
        name: "customer-health-review",
        description: "Review customer health.",
        instructions: "Review the account signals.",
      },
      { toolCallId: "call_skill_1" },
    );
  });
});

describe("edit_workspace_skill tool", () => {
  it("is available only when the authenticated host injects its runner", () => {
    expect(EDIT_WORKSPACE_SKILL_TOOL_NAME in createProductChatToolContext({ model }).tools).toBe(
      false,
    );
    expect(
      EDIT_WORKSPACE_SKILL_TOOL_NAME in
        createProductChatToolContext({ model, editWorkspaceSkill: vi.fn() }).tools,
    ).toBe(true);
  });

  it("passes the complete revised Skill and stable SDK tool-call id to the host", async () => {
    const editWorkspaceSkill = vi.fn(async () => ({
      updated: true as const,
      name: "add-mcp-provider-plugin",
      command: "/add-mcp-provider-plugin",
      bundleId: "skill_bundle_2",
    }));
    const context = createProductChatToolContext({ model, editWorkspaceSkill });
    const skillTool = context.tools[EDIT_WORKSPACE_SKILL_TOOL_NAME] as {
      description: string;
      execute: (args: unknown, context: { toolCallId: string }) => Promise<unknown>;
    };

    await expect(
      skillTool.execute(
        {
          name: " add-mcp-provider-plugin ",
          description: " Add an MCP provider plugin. ",
          instructions: " Preserve existing guidance and add the provider. ",
        },
        { toolCallId: "call_skill_edit_1" },
      ),
    ).resolves.toMatchObject({ updated: true, command: "/add-mcp-provider-plugin" });

    expect(skillTool.description).toContain("existing workspace-authored Skill");
    expect(skillTool.description).toContain("use_skill");
    expect(editWorkspaceSkill).toHaveBeenCalledWith(
      {
        name: "add-mcp-provider-plugin",
        description: "Add an MCP provider plugin.",
        instructions: "Preserve existing guidance and add the provider.",
      },
      { toolCallId: "call_skill_edit_1" },
    );
  });
});

describe("start_task tool", () => {
  it.each(["moonshotai/kimi-k3", "xai/grok-4.3", "anthropic/claude-sonnet-5"])(
    "normalizes a Codex task from %s main chat to the default Codex model",
    async (mainModel) => {
      const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
        id: "task_1",
        displayId: "TASK-1",
        name: task.name ?? "Test repo access",
        prompt: task.prompt,
      }));
      const context = createProductChatToolContext({
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

      expect(startTask).toHaveBeenCalledWith(
        {
          name: "Test repo access",
          prompt: "Check repo access and report whether development work can start.",
          model: CODEX_DEFAULT_MODEL_ID,
          engine: "codex",
        },
        { toolCallId: expect.any(String) },
      );
    },
  );

  it("preserves an already Codex-compatible task model", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Test repo access",
      prompt: task.prompt,
    }));
    const context = createProductChatToolContext({
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

    expect(startTask).toHaveBeenCalledWith(
      {
        name: "Test repo access",
        prompt: "Check repo access and report whether development work can start.",
        model: "openai/gpt-5.5",
        engine: "codex",
      },
      { toolCallId: expect.any(String) },
    );
  });

  it("uses the model explicitly requested for an opencompany task", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Analyze launch",
      prompt: task.prompt,
    }));
    const context = createProductChatToolContext({ model, startTask });
    const startTaskTool = context.tools[START_TASK_TOOL_NAME] as {
      execute: (args: unknown, context: { toolCallId: string }) => Promise<unknown>;
    };

    await startTaskTool.execute(
      {
        name: "Analyze launch",
        prompt: "Analyze the launch plan.",
        engine: "opencompany",
        model: "xai/grok-4.3",
      },
      { toolCallId: "call_model" },
    );

    expect(startTask).toHaveBeenCalledWith(
      {
        name: "Analyze launch",
        prompt: "Analyze the launch plan.",
        model: "xai/grok-4.3",
        engine: "opencompany",
      },
      { toolCallId: "call_model" },
    );
  });

  it("defaults Claude Code tasks to a Claude Code-compatible model", async () => {
    const startTask = vi.fn(async (task: { prompt: string; name?: string }) => ({
      id: "task_1",
      displayId: "TASK-1",
      name: task.name ?? "Review code",
      prompt: task.prompt,
    }));
    const context = createProductChatToolContext({
      model: "moonshotai/kimi-k3",
      requestedEngine: "claude_code",
      startTask,
    });
    const startTaskTool = context.tools[START_TASK_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };

    await startTaskTool.execute({ name: "Review code", prompt: "Review the code." });

    expect(startTask).toHaveBeenCalledWith(
      {
        name: "Review code",
        prompt: "Review the code.",
        model: CLAUDE_CODE_DEFAULT_MODEL_ID,
        engine: "claude_code",
      },
      { toolCallId: expect.any(String) },
    );
  });

  it("rejects a model that is incompatible with the requested coding engine", async () => {
    const startTask = vi.fn();
    const context = createProductChatToolContext({ model, startTask });
    const startTaskTool = context.tools[START_TASK_TOOL_NAME] as {
      execute: (args: unknown) => Promise<unknown>;
    };

    await expect(
      startTaskTool.execute({
        name: "Review code",
        prompt: "Review the code.",
        engine: "codex",
        model: "anthropic/claude-sonnet-5",
      }),
    ).rejects.toThrow("not available for the Codex engine");
    expect(startTask).not.toHaveBeenCalled();
  });

  it("starts distinct tasks for separate calls in the same turn", async () => {
    const startTask = vi.fn(
      async (task: { prompt: string; name?: string }, context: { toolCallId: string }) => ({
        id: `task_${context.toolCallId}`,
        displayId: `TASK-${context.toolCallId}`,
        name: task.name ?? "Task",
        prompt: task.prompt,
      }),
    );
    const context = createProductChatToolContext({ model, startTask });
    const startTaskTool = context.tools[START_TASK_TOOL_NAME] as {
      execute: (args: unknown, context: { toolCallId: string }) => Promise<unknown>;
    };

    const results = await Promise.all([
      startTaskTool.execute(
        { name: "Fix search", prompt: "Fix search.", model: "xai/grok-4.3" },
        { toolCallId: "call_1" },
      ),
      startTaskTool.execute(
        { name: "Fix billing", prompt: "Fix billing.", model: "xai/grok-4.3" },
        { toolCallId: "call_2" },
      ),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ taskId: "task_call_1", status: "queued" }),
      expect.objectContaining({ taskId: "task_call_2", status: "queued" }),
    ]);
    expect(startTask).toHaveBeenCalledTimes(2);
    expect(startTask.mock.calls.map(([, callContext]) => callContext.toolCallId)).toEqual([
      "call_1",
      "call_2",
    ]);
  });
});

describe("update_task_status tool gating", () => {
  it("is absent when no updateTaskStatus runner is injected (interactive chat / Slack)", () => {
    const context = createProductChatToolContext({ model });
    expect(UPDATE_TASK_STATUS_TOOL_NAME in context.tools).toBe(false);
  });

  it("is present only when an updateTaskStatus runner is explicitly injected", async () => {
    const calls: Array<{ status: string; comment: string }> = [];
    const context = createProductChatToolContext({
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
    const absent = createProductChatToolContext({ model });
    const empty = createProductChatToolContext({
      model,
      workflows: {
        catalog: [],
        execute: async () => {
          throw new Error("should not run");
        },
      },
    });
    const available = createProductChatToolContext({
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
    const context = createProductChatToolContext({
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
    const context = createProductChatToolContext({
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

  it("does not start a workflow after a task has already started", async () => {
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
    const context = createProductChatToolContext({
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

describe("prepareProductChatStep maxSteps", () => {
  it("reserves the final step with the default chat budget", () => {
    expect(prepareProductChatStep({ stepNumber: CHAT_MAX_STEPS - 2 })).toEqual({});
    expect(prepareProductChatStep({ stepNumber: CHAT_MAX_STEPS - 1 })).toEqual({
      activeTools: [],
      toolChoice: "none",
    });
  });

  it("reserves the final step at a task's larger budget", () => {
    expect(prepareProductChatStep({ stepNumber: 14, maxSteps: 16 })).toEqual({});
    expect(prepareProductChatStep({ stepNumber: 15, maxSteps: 16 })).toEqual({
      activeTools: [],
      toolChoice: "none",
    });
  });

  it("does not force a paid action on a resumed approval step", () => {
    expect(
      prepareProductChatStep({
        stepNumber: 0,
        forceApprovedAction: true,
      } as Parameters<typeof prepareProductChatStep>[0] & {
        forceApprovedAction: boolean;
      }),
    ).toEqual({});
  });
});
