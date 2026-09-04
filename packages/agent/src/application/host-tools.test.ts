import { describe, expect, it, vi } from "vitest";
import {
  type ChatHostContext,
  type ChatHostToolServiceDependencies,
  executeChatHostToolService,
  workspaceSkillIdempotencyKey,
} from "./host-tools";

const context: ChatHostContext = {
  actorId: "user_1",
  workspaceId: "workspace_1",
  workspaceName: "Analytical Engines",
  conversationId: "conversation_1",
  messageId: "message_1",
  brainRef: null,
  email: "ada@example.test",
  firstName: "Ada",
  lastName: "Lovelace",
  timezone: "Europe/London",
  taskToolsEnabled: true,
  skillToolsEnabled: true,
  legacyBrainEnabled: false,
};

describe("opencompany Chat Task host tools", () => {
  it("derives stable, distinct workspace Skill keys from each model tool call", () => {
    expect(workspaceSkillIdempotencyKey("turn_1", "call_1")).toBe(
      workspaceSkillIdempotencyKey("turn_1", "call_1"),
    );
    expect(workspaceSkillIdempotencyKey("turn_1", "call_1")).not.toBe(
      workspaceSkillIdempotencyKey("turn_1", "call_2"),
    );
    expect(workspaceSkillIdempotencyKey("turn_1", "provider id with spaces")).toMatch(
      /^agent-skill:[a-f0-9]{64}$/,
    );
  });

  it("activates a catalog skill before returning its snapshotted instructions", async () => {
    const resolveSkillMentions = vi.fn(async () => [
      {
        id: "research",
        bundleId: "skill_bundle_research_v1",
        name: "research",
        description: "Research carefully.",
        instructions: "Current instructions.",
        sourceKind: "standalone" as const,
      },
    ]);
    const activateAndListSkills = vi.fn(async () => [
      {
        skillId: "research",
        name: "research",
        description: "Research carefully.",
        instructions: "Chat-fixed instructions.",
      },
    ]);
    const dependencies = testDependencies({ resolveSkillMentions, activateAndListSkills });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "use_skill",
          sessionId: "runtime_1",
          runId: "run_1",
          input: { skill: "research" },
        },
        dependencies,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { skill: { id: "research", instructions: "Chat-fixed instructions." } },
    });
    expect(activateAndListSkills).toHaveBeenCalledWith({
      conversationId: "conversation_1",
      messageId: "message_1",
      workspaceId: "workspace_1",
      skills: [expect.objectContaining({ id: "research" })],
    });
  });

  it("reads one bounded file chunk through the authorized Chat snapshot", async () => {
    const readSkillFile = vi.fn(async () => ({
      path: "references/guide.md",
      executable: false,
      sizeBytes: 10,
      offset: 4,
      nextOffset: 10,
      eof: true,
      encoding: "utf8" as const,
      content: "guide",
    }));
    const dependencies = testDependencies({ readSkillFile });

    await executeChatHostToolService({
      command: {
        operation: "read_skill_file",
        sessionId: "runtime_1",
        runId: "run_1",
        input: { skill: "research", path: "references/guide.md", offset: 4, maxBytes: 64 },
      },
      dependencies,
    });

    expect(readSkillFile).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      conversationId: "conversation_1",
      skill: "research",
      path: "references/guide.md",
      offset: 4,
      maxBytes: 64,
    });
  });

  it("creates a workspace Skill as the authenticated admin with a stable tool-call key", async () => {
    const createWorkspaceSkill = vi.fn(async () => ({
      created: true as const,
      name: "customer-health-review",
      command: "/customer-health-review",
      bundleId: "skill_bundle_1",
    }));
    const dependencies = testDependencies({ createWorkspaceSkill });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "create_workspace_skill",
          sessionId: "runtime_1",
          runId: "turn_1",
          toolCallId: "call_1",
          input: {
            name: "customer-health-review",
            description: "Review customer health.",
            instructions: "# Process\n\nReview the account signals.",
          },
        },
        dependencies,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { created: true, command: "/customer-health-review" },
    });

    expect(createWorkspaceSkill).toHaveBeenCalledWith({
      actor: {
        userId: "user_1",
        workspaceId: "workspace_1",
        role: "admin",
        permissions: ["skill:write"],
        authenticationMethod: "service",
      },
      idempotencyKey: expect.stringMatching(/^agent-skill:[a-f0-9]{64}$/),
      skill: {
        name: "customer-health-review",
        description: "Review customer health.",
        instructions: "# Process\n\nReview the account signals.",
      },
    });
  });

  it("rejects workspace Skill creation when the authenticated member is not an admin", async () => {
    const createWorkspaceSkill = vi.fn();
    const dependencies = testDependencies({
      loadContext: vi.fn(async () => ({ ...context, skillToolsEnabled: false })),
      createWorkspaceSkill,
    });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "create_workspace_skill",
          sessionId: "runtime_1",
          runId: "turn_1",
          toolCallId: "call_1",
          input: { name: "review", description: "Review work.", instructions: "Review it." },
        },
        dependencies,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Only workspace admins can manage Skills from Chat.",
    });
    expect(createWorkspaceSkill).not.toHaveBeenCalled();
  });

  it("updates a workspace Skill as the authenticated admin", async () => {
    const updateWorkspaceSkill = vi.fn(async () => ({
      updated: true as const,
      name: "add-mcp-provider-plugin",
      command: "/add-mcp-provider-plugin",
      bundleId: "skill_bundle_2",
    }));
    const dependencies = testDependencies({ updateWorkspaceSkill });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "edit_workspace_skill",
          sessionId: "runtime_1",
          runId: "turn_1",
          toolCallId: "call_2",
          input: {
            name: "add-mcp-provider-plugin",
            description: "Add an MCP provider plugin.",
            instructions: "Keep the existing workflow and add the provider steps.",
          },
        },
        dependencies,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { updated: true, command: "/add-mcp-provider-plugin" },
    });

    expect(updateWorkspaceSkill).toHaveBeenCalledWith({
      actor: {
        userId: "user_1",
        workspaceId: "workspace_1",
        role: "admin",
        permissions: ["skill:write"],
        authenticationMethod: "service",
      },
      name: "add-mcp-provider-plugin",
      skill: {
        description: "Add an MCP provider plugin.",
        instructions: "Keep the existing workflow and add the provider steps.",
      },
    });
  });

  it("rejects workspace Skill editing when the authenticated member is not an admin", async () => {
    const updateWorkspaceSkill = vi.fn();
    const dependencies = testDependencies({
      loadContext: vi.fn(async () => ({ ...context, skillToolsEnabled: false })),
      updateWorkspaceSkill,
    });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "edit_workspace_skill",
          sessionId: "runtime_1",
          runId: "turn_1",
          toolCallId: "call_2",
          input: {
            name: "review",
            description: "Review work.",
            instructions: "Review it carefully.",
          },
        },
        dependencies,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Only workspace admins can manage Skills from Chat.",
    });
    expect(updateWorkspaceSkill).not.toHaveBeenCalled();
  });

  it("delegates an agent-created Task through the authenticated Task creator", async () => {
    const createTask = vi.fn(async () => taskResult);
    const dependencies = testDependencies({ createTask });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "start_task",
          sessionId: "runtime_1",
          runId: "run_1",
          input: {
            name: "Market research",
            prompt: "Research the market.",
            model: "moonshotai/kimi-k2.6",
            engine: "opencompany",
          },
        },
        dependencies,
      }),
    ).resolves.toEqual({ ok: true, result: taskResult });

    expect(createTask).toHaveBeenCalledWith({
      actorId: "user_1",
      workspaceId: "workspace_1",
      brainRef: null,
      name: "Market research",
      prompt: "Research the market.",
      model: "moonshotai/kimi-k2.6",
      engine: "opencompany",
    });
  });

  it("passes a Brain to created Tasks only when the workspace enables the legacy feature", async () => {
    const createTask = vi.fn(async () => taskResult);
    const dependencies = testDependencies({
      loadContext: vi.fn(async () => ({ ...context, legacyBrainEnabled: true })),
      createTask,
    });

    await executeChatHostToolService({
      command: {
        operation: "start_task",
        sessionId: "runtime_1",
        runId: "run_1",
        input: {
          name: "Market research",
          prompt: "Research the market.",
          model: "moonshotai/kimi-k2.6",
          engine: "opencompany",
        },
      },
      dependencies,
    });

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ brainRef: "brain_1" }));
  });

  it("rejects a task model that the selected coding engine cannot run", async () => {
    const createTask = vi.fn(async () => taskResult);
    const dependencies = testDependencies({ createTask });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "start_task",
          sessionId: "runtime_1",
          runId: "run_1",
          input: {
            name: "Review code",
            prompt: "Review the code.",
            model: "anthropic/claude-sonnet-5",
            engine: "codex",
          },
        },
        dependencies,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Model "anthropic/claude-sonnet-5" is not available for the Codex engine.',
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("rejects rollout-gated task models at the host boundary", async () => {
    const createTask = vi.fn(async () => taskResult);
    const dependencies = testDependencies({ createTask });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "start_task",
          sessionId: "runtime_1",
          runId: "run_1",
          input: {
            name: "Analyze launch",
            prompt: "Analyze the launch.",
            model: "openai/gpt-6-astra",
            engine: "opencompany",
          },
        },
        dependencies,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Unsupported model "openai/gpt-6-astra".',
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("delegates an agent-created Workflow invocation through the Workflow Task creator", async () => {
    const createWorkflowTask = vi.fn(async () => taskResult);
    const dependencies = testDependencies({ createWorkflowTask });

    await expect(
      executeChatHostToolService({
        command: {
          operation: "start_workflow",
          sessionId: "runtime_1",
          runId: "run_1",
          input: { workflowId: "weekly-report", prompt: "Prepare this week's report." },
        },
        dependencies,
      }),
    ).resolves.toEqual({ ok: true, result: taskResult });

    expect(createWorkflowTask).toHaveBeenCalledWith({
      actorId: "user_1",
      workspaceId: "workspace_1",
      mention: { id: "weekly-report" },
      description: "Prepare this week's report.",
    });
  });

  it("binds an agent-created schedule to the active workspace", async () => {
    const createSchedule = vi.fn(async () => ({
      id: "schedule_1",
      name: "Daily briefing",
      cron: "0 9 * * *",
      timezone: "Europe/London",
      nextRunAt: new Date("2026-08-12T08:00:00.000Z"),
      prompt: "Prepare the briefing.",
    }));
    const dependencies = testDependencies({ createSchedule });

    await executeChatHostToolService({
      command: {
        operation: "schedule_task",
        sessionId: "runtime_1",
        runId: "run_1",
        input: {
          name: "Daily briefing",
          cron: "0 9 * * *",
          prompt: "Prepare the briefing.",
        },
      },
      dependencies,
    });

    expect(createSchedule).toHaveBeenCalledWith({
      actorId: "user_1",
      workspaceId: "workspace_1",
      name: "Daily briefing",
      sourceDescription: "",
      cron: "0 9 * * *",
      timezone: "Europe/London",
      prompt: "Prepare the briefing.",
    });
  });

  it("runs a wiki command with a turn+toolCall idempotency key", async () => {
    const runWikiTool = vi.fn(async () => ({ ok: true, result: {} }));
    const dependencies = testDependencies({ runWikiTool });
    await executeChatHostToolService({
      command: {
        operation: "wiki",
        sessionId: "runtime_1",
        runId: "turn_7",
        toolCallId: "call_42",
        input: { command: "write", path: "projects/plan", body: "# Plan" },
      },
      dependencies,
    });
    expect(runWikiTool).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      actorId: "user_1",
      toolInput: { command: "write", path: "projects/plan", body: "# Plan" },
      idempotencyKey: "agent-wiki:turn_7:call_42",
    });
  });

  it("gives two wiki calls in one turn different idempotency keys", async () => {
    const runWikiTool = vi.fn(async () => ({ ok: true, result: {} }));
    const dependencies = testDependencies({ runWikiTool });
    for (const toolCallId of ["call_a", "call_b"]) {
      await executeChatHostToolService({
        command: {
          operation: "wiki",
          sessionId: "runtime_1",
          runId: "turn_7",
          toolCallId,
          input: { command: "tree" },
        },
        dependencies,
      });
    }
    const keys = (runWikiTool.mock.calls as unknown as Array<[{ idempotencyKey: string }]>).map(
      ([call]) => call.idempotencyKey,
    );
    expect(keys).toEqual(["agent-wiki:turn_7:call_a", "agent-wiki:turn_7:call_b"]);
  });
});

const taskResult = {
  id: "task_1",
  displayId: "TASK-1",
  name: "Market research",
  prompt: "Research the market.",
};

function testDependencies(
  overrides: Partial<ChatHostToolServiceDependencies>,
): ChatHostToolServiceDependencies {
  return {
    loadContext: vi.fn(async () => context),
    listBrains: vi.fn(async () => [{ id: "brain_1", slug: "home" }]),
    defaultBrainSlug: "home",
    browserProfilesAvailable: () => false,
    createAgentSession: vi.fn(),
    endAgentSession: vi.fn(),
    listBrowserProfiles: vi.fn(async () => []),
    resolveActiveAgentSession: vi.fn(async () => null),
    resolveSkillMentions: vi.fn(async () => []),
    listSkillCatalog: vi.fn(async () => []),
    activateAndListSkills: vi.fn(async () => []),
    readSkillFile: vi.fn(),
    createWorkspaceSkill: vi.fn(),
    updateWorkspaceSkill: vi.fn(),
    createTask: vi.fn(async () => taskResult),
    listSchedules: vi.fn(async () => []),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    createWorkflowTask: vi.fn(async () => taskResult),
    listWorkflowCatalog: vi.fn(async () => []),
    executeBrowserTool: vi.fn(),
    runWikiTool: vi.fn(),
    ...overrides,
  };
}
