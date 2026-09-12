import { describe, expect, it, vi } from "vitest";
import {
  type ChatHostContext,
  type ChatHostToolServiceDependencies,
  executeChatHostToolService,
  workspaceSkillIdempotencyKey,
} from "./host-tools";

const context: ChatHostContext = {
  taskConversation: false,
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
  subagentsEnabled: false,
  legacyBrainEnabled: false,
};

describe("opencompany Chat Task host tools", () => {
  it("does not advertise task delegation or schedules in a task conversation", async () => {
    const dependencies = testDependencies({
      loadContext: vi.fn(async () => ({ ...context, taskConversation: true })),
    });

    await expect(
      executeChatHostToolService({
        command: { operation: "bootstrap", sessionId: "runtime_1", runId: "run_1" },
        dependencies,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { taskToolsEnabled: false, workflows: [], recurringSchedules: [] },
    });
    expect(dependencies.listWorkflowCatalog).not.toHaveBeenCalled();
    expect(dependencies.listSchedules).not.toHaveBeenCalled();
  });

  it("carries the member's subagent preference, except inside a task conversation", async () => {
    const enabled = { ...context, subagentsEnabled: true };

    await expect(
      executeChatHostToolService({
        command: { operation: "bootstrap", sessionId: "runtime_1", runId: "run_1" },
        dependencies: testDependencies({ loadContext: vi.fn(async () => enabled) }),
      }),
    ).resolves.toMatchObject({ ok: true, result: { subagentsEnabled: true } });

    await expect(
      executeChatHostToolService({
        command: { operation: "bootstrap", sessionId: "runtime_1", runId: "run_1" },
        dependencies: testDependencies({
          loadContext: vi.fn(async () => ({ ...enabled, taskConversation: true })),
        }),
      }),
    ).resolves.toMatchObject({ ok: true, result: { subagentsEnabled: false } });
  });

  it("leaves subagents off for a member who has not opted in", async () => {
    await expect(
      executeChatHostToolService({
        command: { operation: "bootstrap", sessionId: "runtime_1", runId: "run_1" },
        dependencies: testDependencies({ loadContext: vi.fn(async () => context) }),
      }),
    ).resolves.toMatchObject({ ok: true, result: { subagentsEnabled: false } });
  });

  it.each([
    "start_task",
    "start_workflow",
    "schedule_task",
    "edit_task_schedule",
    "delete_task_schedule",
  ] as const)("rejects direct %s calls from tasks before any side effect", async (operation) => {
    const dependencies = testDependencies({
      loadContext: vi.fn(async () => ({ ...context, taskConversation: true })),
    });

    await expect(
      executeChatHostToolService({
        command: {
          operation,
          sessionId: "runtime_1",
          runId: "run_1",
          input: {
            taskConversation: false,
            name: "Research",
            prompt: "Research the requested topic.",
            model: "moonshotai/kimi-k2.6",
            engine: "opencompany",
            workflowId: "research",
            cron: "0 9 * * *",
          },
        },
        dependencies,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Tasks cannot create other tasks or manage task schedules. Use a main chat instead.",
    });
    expect(dependencies.createTask).not.toHaveBeenCalled();
    expect(dependencies.createWorkflowTask).not.toHaveBeenCalled();
    expect(dependencies.createSchedule).not.toHaveBeenCalled();
    expect(dependencies.listSchedules).not.toHaveBeenCalled();
    expect(dependencies.updateSchedule).not.toHaveBeenCalled();
    expect(dependencies.deleteSchedule).not.toHaveBeenCalled();
  });

  it("keeps the acting member when a task resolves plugin Skills and restricts standalone Skills to company scope", async () => {
    const dependencies = testDependencies({
      loadContext: vi.fn(async () => ({ ...context, taskConversation: true })),
    });
    const result = await executeChatHostToolService({
      command: {
        operation: "bootstrap",
        sessionId: "runtime_1",
        runId: "run_1",
        input: { mentionedSkillIds: ["plugin-skill"] },
      },
      dependencies,
    });
    expect(result.ok).toBe(true);
    expect(dependencies.resolveSkillMentions).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      userId: "user_1",
      skillAccess: "company",
      mentions: [{ id: "plugin-skill" }],
    });
    expect(dependencies.listSkillCatalog).toHaveBeenCalledWith("workspace_1", "user_1", "company");
  });

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
        scope: "company" as const,
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
      userId: "user_1",
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
      userId: "user_1",
      workspaceId: "workspace_1",
      conversationId: "conversation_1",
      skill: "research",
      path: "references/guide.md",
      offset: 4,
      maxBytes: 64,
    });
  });

  it.each([true, false])(
    "gates Skill management on current session authority (%s)",
    async (enabled) => {
      const manageWorkspaceSkills = vi.fn(async () => ({ archived: true }));
      const dependencies = testDependencies({
        manageWorkspaceSkills,
        loadContext: vi.fn(async () => ({ ...context, skillToolsEnabled: enabled })),
      });
      const response = await executeChatHostToolService({
        command: {
          operation: "workspace_skills",
          sessionId: "runtime_1",
          runId: "run_1",
          input: { command: "archive", name: "my-skill", workspaceId: "untrusted" },
        },
        dependencies,
      });
      expect(response.ok).toBe(enabled);
      if (enabled) {
        expect(manageWorkspaceSkills).toHaveBeenCalledWith(
          expect.objectContaining({
            actor: expect.objectContaining({ workspaceId: "workspace_1", userId: "user_1" }),
            command: "archive",
            name: "my-skill",
          }),
        );
      } else expect(manageWorkspaceSkills).not.toHaveBeenCalled();
    },
  );

  it("creates a workspace Skill as the authenticated member with a stable tool-call key", async () => {
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
        role: "member",
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

  it("rejects workspace Skill creation when Skill tools are unavailable", async () => {
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
      error: "Skill tools are unavailable for this user.",
    });
    expect(createWorkspaceSkill).not.toHaveBeenCalled();
  });

  it("forwards partial Skill edits to the authenticated update service", async () => {
    const updateWorkspaceSkill = vi.fn(async () => ({
      updated: true as const,
      name: "renamed-skill",
      command: "/renamed-skill",
      bundleId: "bundle_2",
    }));
    await executeChatHostToolService({
      command: {
        operation: "edit_workspace_skill",
        sessionId: "runtime_1",
        runId: "turn_1",
        toolCallId: "rename_1",
        input: { name: "installation_1", newName: "renamed-skill", expectedBundleId: "bundle_1" },
      },
      dependencies: testDependencies({ updateWorkspaceSkill }),
    });
    expect(updateWorkspaceSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "installation_1",
        skill: { newName: "renamed-skill", expectedBundleId: "bundle_1" },
      }),
    );
  });

  it("updates a workspace Skill as the authenticated member", async () => {
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
        role: "member",
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

  it("rejects workspace Skill editing when Skill tools are unavailable", async () => {
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
      error: "Skill tools are unavailable for this user.",
    });
    expect(updateWorkspaceSkill).not.toHaveBeenCalled();
  });

  it.each([
    { model: "moonshotai/kimi-k2.6", engine: "opencompany" },
    { model: "openai/gpt-6-astra", engine: "codex" },
  ])("delegates $model tasks through the authenticated Task creator", async ({ model, engine }) => {
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
            model,
            engine,
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
      model,
      engine,
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

  it("publishes an artifact with the authenticated context and stable tool-call id", async () => {
    const writeArtifact = vi.fn(async () => ({ ok: true, artifact: { artifactId: "artifact_1" } }));
    const dependencies = testDependencies({ writeArtifact });
    const result = await executeChatHostToolService({
      command: {
        operation: "write_artifact",
        sessionId: "runtime_1",
        runId: "turn_7",
        toolCallId: "call_42",
        input: { filename: "report.md", title: "Report", content: "# Report" },
      },
      dependencies,
    });

    expect(result).toMatchObject({ ok: true, result: { ok: true } });
    expect(writeArtifact).toHaveBeenCalledWith({
      context,
      runId: "turn_7",
      toolCallId: "call_42",
      toolInput: { filename: "report.md", title: "Report", content: "# Report" },
      signal: expect.any(AbortSignal),
    });
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
    manageWorkspaceSkills: vi.fn(),
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
