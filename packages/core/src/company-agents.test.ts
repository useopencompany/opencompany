import { describe, expect, it, vi } from "vitest";
import { type Actor, WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION } from "./actor";
import { CompanyAgentApplicationService } from "./company-agents";
import type { CreateTaskResult } from "./tasks";
import {
  type AutomationExecutionPlanner,
  type AutomationTaskCreator,
  type ScheduleRules,
  type Workflow,
  WorkflowApplicationService,
  type WorkflowRepository,
} from "./workflows";

const now = new Date("2026-09-18T08:00:00.000Z");
const OWNER = "user_owner";
const TEAMMATE = "user_teammate";

describe("CompanyAgentApplicationService", () => {
  it("runs on the owner's authority no matter who starts the run", async () => {
    const planner = fakePlanner();
    const taskCreator = fakeTaskCreator();
    const { agents } = agentService({ planner, taskCreator });

    await agents.runAgentNow(actor({ userId: TEAMMATE }), "agent_1", "run-key");

    // Planning decides which connected tools the run gets. It has to resolve to the owner, or a
    // teammate pressing Run now would quietly execute on their own credentials.
    expect(planner.prepareWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ userId: OWNER }) }),
    );
    expect(taskCreator.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ userId: OWNER }),
        // The work belongs to the agent, which is what keeps it out of the owner's Task list.
        agentId: "agent_1",
      }),
    );
  });

  it("refuses configuration from anyone but the owner", async () => {
    const { agents } = agentService();

    await expect(
      agents.updateAgent(actor({ userId: TEAMMATE }), "agent_1", updateInput()),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      agents.archiveAgent(actor({ userId: TEAMMATE }), "agent_1", 1),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      agents.authorizeAgentWrite(actor({ userId: TEAMMATE }), "agent_1"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lets a teammate read the agent and its runs", async () => {
    const { agents } = agentService();
    const teammate = actor({ userId: TEAMMATE });

    await expect(agents.getAgent(teammate, "agent_1")).resolves.toMatchObject({
      name: "PR Reviewer",
      ownerUserId: OWNER,
      status: "active",
    });
    await expect(agents.listAgentRuns(teammate, "agent_1")).resolves.toEqual([]);
  });

  it("blocks runs and edits once the owner has left the workspace", async () => {
    const planner = fakePlanner();
    const { agents } = agentService({
      planner,
      workflow: agentWorkflow({ ownerUserId: OWNER, ownerActive: false }),
    });

    await expect(agents.runAgentNow(actor(), "agent_1", "run-key")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(agents.updateAgent(actor(), "agent_1", updateInput())).rejects.toMatchObject({
      code: "invalid_argument",
    });
    // Nothing was planned, so no other member's connections were reached for.
    expect(planner.prepareWorkflow).not.toHaveBeenCalled();
  });

  it("derives the Slack identity from the agent and keeps it company-scoped", async () => {
    const repository = fakeRepository(agentWorkflow());
    const { agents } = agentService({ repository });

    await agents.updateAgent(actor(), "agent_1", {
      ...updateInput(),
      name: "Release Captain",
      photoUrl: "https://cdn.example.com/agent.png",
      slackEnabled: true,
    });

    expect(repository.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "company",
        slackChannel: {
          enabled: true,
          displayName: "Release Captain",
          avatarUrl: "https://cdn.example.com/agent.png",
        },
      }),
    );
  });

  it("stores a paused agent as inactive so its triggers stop firing", async () => {
    const repository = fakeRepository(agentWorkflow());
    const { agents } = agentService({ repository });

    await agents.updateAgent(actor(), "agent_1", { ...updateInput(), status: "paused" });

    expect(repository.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ status: "draft" }),
    );
  });

  it("folds the single standing instruction into one step", async () => {
    const repository = fakeRepository(agentWorkflow());
    const { agents } = agentService({ repository });

    await agents.updateAgent(actor(), "agent_1", {
      ...updateInput(),
      instructions: "Review the diff and post what matters.",
      model: "provider/model",
    });

    expect(repository.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            instructions: "Review the diff and post what matters.",
            model: "provider/model",
          }),
        ],
      }),
    );
  });

  it("does not expose a workflow row through the agents surface", async () => {
    const { agents } = agentService({ workflow: agentWorkflow({ kind: "workflow" }) });

    await expect(agents.getAgent(actor(), "agent_1")).rejects.toMatchObject({ code: "not_found" });
  });
});

function agentService(
  overrides: {
    planner?: ReturnType<typeof fakePlanner>;
    taskCreator?: ReturnType<typeof fakeTaskCreator>;
    repository?: ReturnType<typeof fakeRepository>;
    workflow?: Workflow;
  } = {},
) {
  const repository = overrides.repository ?? fakeRepository(overrides.workflow ?? agentWorkflow());
  const workflows = new WorkflowApplicationService(repository, {
    kind: "agent",
    scheduleRules: scheduleRules(),
    planner: overrides.planner ?? fakePlanner(),
    taskCreator: overrides.taskCreator ?? fakeTaskCreator(),
    now: () => now,
  });
  return { agents: new CompanyAgentApplicationService(workflows), repository };
}

function updateInput() {
  return {
    expectedVersion: 1,
    name: "PR Reviewer",
    description: "Reviews pull requests.",
    instructions: "Review the diff.",
    photoUrl: "",
    model: "provider/model",
    status: "active" as const,
    slackEnabled: false,
    triggers: [],
  };
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: OWNER,
    workspaceId: "workspace_1",
    role: "member",
    permissions: [WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION],
    authenticationMethod: "session",
    ...overrides,
  };
}

function agentWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "agent_1",
    slug: "pr-reviewer",
    kind: "agent",
    name: "PR Reviewer",
    description: "Reviews pull requests.",
    steps: [
      { id: "agent_1-instructions", title: "", model: "provider/model", instructions: "Review." },
    ],
    status: "active",
    scope: "company",
    slackChannel: { enabled: false, displayName: "PR Reviewer", avatarUrl: "" },
    createdByUserId: OWNER,
    ownerUserId: OWNER,
    ownerActive: true,
    lastRunAt: null,
    trigger: { type: "manual" },
    triggers: [],
    version: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeRepository(stored: Workflow): WorkflowRepository & {
  updateWorkflow: ReturnType<typeof vi.fn>;
  archiveWorkflow: ReturnType<typeof vi.fn>;
} {
  return {
    listWorkflows: vi.fn(async () => ({ workflows: [stored], nextCursor: null })),
    getWorkflow: vi.fn(async ({ workflowId }) =>
      workflowId === stored.id || workflowId === stored.slug ? stored : null,
    ),
    createWorkflow: vi.fn(async () => ({
      workflow: stored,
      transactionId: "42",
      idempotentReplay: false,
    })),
    updateWorkflow: vi.fn(async () => ({
      status: "updated" as const,
      value: { ...stored, version: 2 },
      transactionId: "43",
    })),
    archiveWorkflow: vi.fn(async () => ({
      status: "updated" as const,
      value: { workflowId: stored.id, version: 2 },
      transactionId: "44",
    })),
    listRuns: vi.fn(async () => []),
    recordRunNow: vi.fn(async () => undefined),
    getWorkflowMemory: vi.fn(async () => null),
    setWorkflowMemoryEnabled: vi.fn(async () => null),
    clearWorkflowMemory: vi.fn(async () => null),
  };
}

function fakePlanner(): AutomationExecutionPlanner & {
  prepareWorkflow: ReturnType<typeof vi.fn>;
} {
  return {
    prepareWorkflow: vi.fn(async () => ({
      engine: "opencompany" as const,
      model: "provider/model",
      payload: { engine: "opencompany", model: "provider/model" },
    })),
  };
}

function fakeTaskCreator(): AutomationTaskCreator & { create: ReturnType<typeof vi.fn> } {
  return { create: vi.fn(async () => taskResult()) };
}

function scheduleRules(): ScheduleRules {
  return {
    normalize: ({ cron, timezone }) => ({
      cron,
      timezone: timezone ?? "UTC",
      nextRunAt: new Date("2026-09-19T08:00:00.000Z"),
    }),
  };
}

function taskResult(): CreateTaskResult {
  return {
    task: {
      id: "task_1",
      displayId: "TASK-1",
      name: "PR Reviewer",
      goal: "Review.",
      conversationId: "conversation_1",
      status: "queued",
      source: "workflow",
      engine: "opencompany",
      model: "provider/model",
      workflowId: "pr-reviewer",
      scheduleId: null,
      scheduledFor: null,
      outcome: { result: null, error: null, reportedStatus: null, comment: null },
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    messageId: "message_1",
    assistantMessageId: "message_2",
    runId: "run_1",
    transactionId: "42",
    idempotentReplay: false,
  };
}
