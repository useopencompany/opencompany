import {
  type Actor,
  WORKFLOW_READ_PERMISSION,
  WORKFLOW_WRITE_PERMISSION,
  type Workflow,
  WorkflowApplicationService,
  type WorkflowRepository,
} from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { executeWorkflowCommand } from "./workflow-commands";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: [WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION],
  authenticationMethod: "service",
};
const now = new Date("2026-09-17T12:00:00Z");
function fixture() {
  let stored: Workflow = {
    id: "workflow_1",
    slug: "monitor",
    kind: "workflow",
    name: "Monitor",
    description: "Watch releases",
    steps: [{ id: "step_1", title: "Watch", model: "kimi-k2.6", instructions: "Watch releases" }],
    scope: "personal",
    createdByUserId: actor.userId,
    ownerUserId: null,
    ownerActive: false,
    lastRunAt: null,
    slackChannel: { enabled: false, displayName: "Custom bot", avatarUrl: "" },
    status: "active",
    trigger: { type: "manual" },
    triggers: [],
    version: 4,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  let memory = {
    workflowId: stored.id,
    enabled: true,
    content: "Already processed release 1",
    updatedAt: now as Date | null,
  };
  let created = false;
  const repository: WorkflowRepository = {
    listWorkflows: vi.fn(async () => ({ workflows: [stored], nextCursor: null })),
    getWorkflow: vi.fn(async ({ workflowId }) =>
      workflowId === stored.id || workflowId === stored.slug ? structuredClone(stored) : null,
    ),
    createWorkflow: vi.fn(async (input) => {
      const replay = created;
      if (!created)
        stored = {
          ...stored,
          name: input.name,
          description: input.description,
          scope: input.scope,
          steps: [input.initialStep],
          status: "draft",
          version: 1,
        };
      created = true;
      return { workflow: structuredClone(stored), transactionId: "1", idempotentReplay: replay };
    }),
    updateWorkflow: vi.fn(async (input: Parameters<WorkflowRepository["updateWorkflow"]>[0]) => {
      if (input.expectedVersion !== stored.version) return { status: "conflict" as const };
      stored = {
        ...stored,
        name: input.name,
        description: input.description,
        scope: input.scope,
        slackChannel: input.slackChannel,
        steps: input.steps,
        status: input.status,
        trigger: input.trigger as Workflow["trigger"],
        triggers: input.automationTriggers?.map((item) => item.trigger) ?? stored.triggers ?? [],
        version: stored.version + 1,
      };
      return { status: "updated" as const, value: structuredClone(stored), transactionId: "2" };
    }),
    archiveWorkflow: vi.fn(async () => ({
      status: "updated" as const,
      value: { workflowId: stored.id, version: stored.version + 1 },
      transactionId: "3",
    })),
    getWorkflowMemory: vi.fn(async () => memory),
    setWorkflowMemoryEnabled: vi.fn(async ({ enabled }) => (memory = { ...memory, enabled })),
    clearWorkflowMemory: vi.fn(async () => (memory = { ...memory, content: "", updatedAt: null })),
    listRuns: vi.fn(async () => []),
    recordRunNow: vi.fn(async () => undefined),
  };
  const planner = {
    prepareWorkflow: vi.fn(async () => ({
      engine: "opencompany" as const,
      model: "moonshotai/kimi-k2.6",
      payload: { prompt: "watch" },
    })),
  };
  const service = new WorkflowApplicationService(repository, {
    planner,
    taskCreator: { create: vi.fn() },
    scheduleRules: {
      normalize: (input) =>
        input.cron === "bad"
          ? null
          : {
              cron: input.cron,
              timezone: input.timezone ?? "UTC",
              nextRunAt: new Date("2026-09-18T07:00:00Z"),
            },
    },
    now: () => now,
  });
  const run = (command: Record<string, unknown>, acting = actor) =>
    executeWorkflowCommand({
      actor: acting,
      command,
      idempotencyKey: "call_1",
      workflows: service,
    });
  return {
    run,
    repository,
    planner,
    get: () => stored,
    memory: () => memory,
    set: (patch: Partial<Workflow>) => {
      stored = { ...stored, ...patch };
    },
  };
}

describe("workflow chat commands through the canonical service", () => {
  it("creates one active personal schedule with memory before activation and replays without overwriting", async () => {
    const f = fixture();
    const command = {
      command: "create",
      name: "Dia monitor",
      instructions: "Check releases and remember processed releases.",
      status: "active",
      schedule: { cron: "0 9 * * 5", timezone: "Europe/Berlin" },
      memoryEnabled: true,
    };
    const result = await f.run(command);
    expect(result).toMatchObject({
      ok: true,
      workflow: {
        status: "active",
        scope: "personal",
        memory: { enabled: true },
        steps: [{ model: "kimi-k2.6" }],
        triggers: [
          {
            cron: "0 9 * * 5",
            timezone: "Europe/Berlin",
            nextRunAt: new Date("2026-09-18T07:00:00Z"),
          },
        ],
      },
    });
    expect(f.repository.setWorkflowMemoryEnabled).toHaveBeenCalledOnce();
    expect(f.planner.prepareWorkflow).toHaveBeenCalledOnce();
    f.set({ name: "Edited later" });
    expect(await f.run(command)).toMatchObject({
      operation: "replayed",
      workflow: { name: "Edited later" },
    });
    expect(f.repository.updateWorkflow).toHaveBeenCalledTimes(2);
  });
  it("enables requested memory before activating an existing draft", async () => {
    const f = fixture();
    f.set({ status: "draft" });
    f.memory().enabled = false;
    f.planner.prepareWorkflow.mockImplementationOnce(async () => {
      expect(f.memory().enabled).toBe(true);
      return {
        engine: "opencompany" as const,
        model: "moonshotai/kimi-k2.6",
        payload: { prompt: "watch" },
      };
    });
    expect(
      await f.run({
        command: "update",
        workflowId: "monitor",
        expectedVersion: 4,
        status: "active",
        schedule: { cron: "0 9 * * 5", timezone: "Europe/Berlin" },
        memoryEnabled: true,
      }),
    ).toMatchObject({ ok: true, workflow: { status: "active", memory: { enabled: true } } });
    expect(f.planner.prepareWorkflow).toHaveBeenCalledOnce();
  });
  it("keeps an incomplete draft and reports activation blockers", async () => {
    const f = fixture();
    expect(await f.run({ command: "create", name: "Draft" })).toMatchObject({
      ok: true,
      workflow: {
        status: "draft",
        scope: "personal",
        activationBlockers: [expect.stringContaining("instructions")],
      },
    });
    expect(f.planner.prepareWorkflow).not.toHaveBeenCalled();
  });
  it("renames without losing steps, models, triggers, channels, memory or active status", async () => {
    const f = fixture();
    const previous = structuredClone(f.get());
    expect(
      await f.run({
        command: "update",
        workflowId: "monitor",
        expectedVersion: 4,
        name: "Renamed",
      }),
    ).toMatchObject({ ok: true, changedFields: ["name"] });
    expect(f.get()).toMatchObject({ ...previous, name: "Renamed", version: 5 });
    expect(f.memory().content).toBe("Already processed release 1");
    expect(f.repository.setWorkflowMemoryEnabled).not.toHaveBeenCalled();
  });
  it("rejects a stale version before any write", async () => {
    const f = fixture();
    await expect(
      f.run({ command: "update", workflowId: "monitor", expectedVersion: 3, name: "Stale" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.repository.updateWorkflow).not.toHaveBeenCalled();
  });
  it("preserves the last active definition when planning fails", async () => {
    const f = fixture();
    const before = structuredClone(f.get());
    f.planner.prepareWorkflow.mockRejectedValueOnce(new Error("Connection unavailable"));
    expect(
      await f.run({
        command: "update",
        workflowId: "monitor",
        expectedVersion: 4,
        schedule: { cron: "0 9 * * 5", timezone: "Europe/Berlin" },
      }),
    ).toMatchObject({
      ok: false,
      partial: false,
      error: "Connection unavailable",
      workflow: { status: "active", version: 4 },
    });
    expect(f.get()).toEqual(before);
  });
  it("reports the same recoverable draft after a failed create and retry", async () => {
    const f = fixture();
    const args = {
      command: "create",
      name: "Bad schedule",
      status: "active",
      instructions: "Check",
      schedule: { cron: "bad", timezone: "UTC" },
    };
    expect(await f.run(args)).toMatchObject({
      ok: false,
      partial: true,
      workflow: { id: "workflow_1", status: "draft" },
    });
    expect(await f.run(args)).toMatchObject({
      ok: false,
      operation: "replayed",
      workflow: { id: "workflow_1", status: "draft" },
    });
  });
  it("refuses to flatten advanced workflows and keeps their step IDs", async () => {
    const f = fixture();
    f.set({
      steps: [
        ...f.get().steps,
        { id: "step_2", title: "Summarize", instructions: "Summarize", model: "kimi-k2.6" },
      ],
    });
    expect(
      await f.run({
        command: "update",
        workflowId: "monitor",
        expectedVersion: 4,
        instructions: "Replace",
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("multiple steps") });
    expect(f.repository.updateWorkflow).not.toHaveBeenCalled();
  });
  it("disables memory without clearing content and never returns memory content", async () => {
    const f = fixture();
    const result = await f.run({
      command: "update",
      workflowId: "monitor",
      expectedVersion: 4,
      memoryEnabled: false,
    });
    expect(result).toMatchObject({ workflow: { memory: { enabled: false }, version: 4 } });
    expect(JSON.stringify(result)).not.toContain("Already processed");
    expect(f.memory().content).toBe("Already processed release 1");
    await f.run({ command: "clear_memory", workflowId: "monitor", expectedVersion: 4 });
    expect(f.memory().content).toBe("");
  });
  it("enforces permissions and refuses extra fields for lifecycle commands", async () => {
    const f = fixture();
    await expect(
      f.run(
        { command: "create", name: "Denied" },
        { ...actor, permissions: [WORKFLOW_READ_PERMISSION] },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.run({ command: "pause", workflowId: "monitor", expectedVersion: 4, name: "Ignored?" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(f.repository.updateWorkflow).not.toHaveBeenCalled();
  });
});

describe("workflow schedule readback", () => {
  it("keeps the schedule while removing the next-run claim after pause", async () => {
    const f = fixture();
    const trigger = {
      id: "schedule_1",
      type: "schedule" as const,
      cron: "0 9 * * 5",
      timezone: "Europe/Berlin",
      prompt: "Run this workflow.",
      enabled: true,
      lastRunAt: null,
      nextRunAt: new Date("2026-09-18T07:00:00Z"),
    };
    f.set({ trigger, triggers: [trigger] });
    expect(
      await f.run({ command: "pause", workflowId: "monitor", expectedVersion: 4 }),
    ).toMatchObject({
      ok: true,
      operation: "paused",
      workflow: {
        status: "draft",
        triggers: [{ id: "schedule_1", cron: "0 9 * * 5", nextRunAt: null }],
      },
    });
    expect(f.planner.prepareWorkflow).not.toHaveBeenCalled();
  });
});
