import {
  type Actor,
  TASK_WRITE_PERMISSION,
  WORKFLOW_READ_PERMISSION,
  WORKFLOW_WRITE_PERMISSION,
} from "./actor";
import { CoreError } from "./chat";
import type { CreateTaskResult } from "./tasks";
import type {
  Workflow,
  WorkflowApplicationService,
  WorkflowAutomationTrigger,
  WorkflowAutomationTriggerInput,
  WorkflowRun,
} from "./workflows";

// A Company agent is a named, workspace-owned automation with a standing responsibility, a display
// identity, and a designated human owner. It is stored as an automation row of kind "agent", so it
// inherits triggers, scheduling, event routing, Slack delivery, and session continuation from
// Workflows. What it does not inherit is execution authority: every run of an agent executes with
// the owner's authorized connections, whoever pressed the button.
export type CompanyAgentStatus = "active" | "paused";

export type CompanyAgent = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  photoUrl: string;
  model: string;
  runtimeModel?: string;
  reasoningEffort?: string;
  status: CompanyAgentStatus;
  ownerUserId: string | null;
  // False when the owner left the workspace or was never recorded. Runs and trigger changes are
  // blocked in that state rather than falling back to the caller's own connections.
  ownerActive: boolean;
  slackEnabled: boolean;
  triggers: WorkflowAutomationTrigger[];
  lastRunAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CompanyAgentPage = {
  agents: CompanyAgent[];
  nextCursor: string | null;
};

export type CompanyAgentRun = WorkflowRun;

export type CompanyAgentMutationResult = {
  agent: CompanyAgent;
  transactionId: string;
  idempotentReplay: boolean;
};

export type CompanyAgentVersionResult = {
  agent: CompanyAgent;
  transactionId: string;
};

export type UpdateCompanyAgentInput = {
  expectedVersion: number;
  name: string;
  description: string;
  instructions: string;
  photoUrl: string;
  model: string;
  runtimeModel?: string;
  reasoningEffort?: string;
  status: CompanyAgentStatus;
  slackEnabled: boolean;
  triggers: WorkflowAutomationTriggerInput[];
};

// Every agent write goes through the same Workflow service the Workflows surface uses, but over a
// repository pinned to kind "agent". This class owns the two rules that make an agent an agent:
// only its owner may configure it, and every run carries the owner's authority.
export class CompanyAgentApplicationService {
  constructor(private readonly workflows: WorkflowApplicationService) {}

  async listAgents(
    actor: Actor,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<CompanyAgentPage> {
    const page = await this.workflows.listWorkflows(actor, input);
    return { agents: page.workflows.map(toCompanyAgent), nextCursor: page.nextCursor };
  }

  async getAgent(actor: Actor, agentId: string): Promise<CompanyAgent> {
    return toCompanyAgent(await this.workflow(actor, agentId));
  }

  async createAgent(
    actor: Actor,
    input: { idempotencyKey: string; name: string; description?: string },
  ): Promise<CompanyAgentMutationResult> {
    const result = await this.workflows.createWorkflow(actor, {
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      scope: "company",
    });
    return {
      agent: toCompanyAgent(result.workflow),
      transactionId: result.transactionId,
      idempotentReplay: result.idempotentReplay,
    };
  }

  // Configuration is owner-only and enforced here, not just in the UI: the update runs as the
  // owner so the triggers it activates, and the harness they carry, bind to the owner's identity.
  async updateAgent(
    actor: Actor,
    agentId: string,
    input: UpdateCompanyAgentInput,
  ): Promise<CompanyAgentVersionResult> {
    const current = await this.workflow(actor, agentId);
    const owner = this.requireOwner(actor, current);
    const step = current.steps[0];
    const result = await this.workflows.updateWorkflow(owner, current.id, {
      expectedVersion: input.expectedVersion,
      name: input.name,
      description: input.description,
      steps: [
        {
          id: step?.id ?? `${current.id}-instructions`,
          title: "",
          model: input.model,
          ...(input.runtimeModel ? { runtimeModel: input.runtimeModel } : {}),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          instructions: input.instructions,
        },
      ],
      status: input.status === "active" ? "active" : "draft",
      scope: "company",
      // An agent posts to Slack under its own name and photo. Deriving both from the agent removes
      // a second identity to keep in sync, which is why the editor has no Slack name field.
      slackChannel: {
        enabled: input.slackEnabled,
        displayName: input.name,
        avatarUrl: input.photoUrl,
      },
      trigger: { type: "manual" },
      triggers: input.triggers,
    });
    return { agent: toCompanyAgent(result.workflow), transactionId: result.transactionId };
  }

  async archiveAgent(actor: Actor, agentId: string, expectedVersion: number) {
    const current = await this.workflow(actor, agentId);
    const owner = this.requireOwner(actor, current);
    return this.workflows.archiveWorkflow(owner, current.id, expectedVersion);
  }

  // Any workspace member can start a run; the run executes as the owner. `runWorkflowNow` is
  // called with the owner actor so planning, tool access, and Task ownership all resolve to the
  // owner rather than to whoever pressed Run now.
  async runAgentNow(
    actor: Actor,
    agentId: string,
    idempotencyKey: string,
  ): Promise<CreateTaskResult> {
    const current = await this.workflow(actor, agentId);
    const owner = this.ownerActor(actor, current);
    return this.workflows.runWorkflowNow(owner, current.id, idempotencyKey);
  }

  async listAgentRuns(actor: Actor, agentId: string, limit?: number): Promise<CompanyAgentRun[]> {
    const current = await this.workflow(actor, agentId);
    return this.workflows.listRuns(actor, current.id, limit);
  }

  // Authorizes the photo upload, which stores bytes before the editor saves the resulting URL.
  async authorizeAgentWrite(actor: Actor, agentId: string): Promise<string> {
    const current = await this.workflow(actor, agentId);
    this.requireOwner(actor, current);
    return current.id;
  }

  private async workflow(actor: Actor, agentId: string): Promise<Workflow> {
    const workflow = await this.workflows.getWorkflow(actor, agentId);
    if (workflow.kind !== "agent") throw new CoreError("not_found", "Agent not found.");
    return workflow;
  }

  // The identity every run of this agent executes as. It is derived from the agent row, never
  // from the caller, so a teammate pressing Run now still runs on the owner's connections.
  private ownerActor(actor: Actor, workflow: Workflow): Actor {
    if (!workflow.ownerUserId || !workflow.ownerActive) {
      throw new CoreError(
        "invalid_argument",
        "This agent has no active owner, so its work cannot run. Its connections left with the owner.",
      );
    }
    return {
      userId: workflow.ownerUserId,
      // The row was read through the caller's workspace, so this is the agent's workspace.
      workspaceId: actor.workspaceId,
      role: "member",
      permissions: [WORKFLOW_READ_PERMISSION, WORKFLOW_WRITE_PERMISSION, TASK_WRITE_PERMISSION],
      authenticationMethod: "service",
    };
  }

  private requireOwner(actor: Actor, workflow: Workflow): Actor {
    const owner = this.ownerActor(actor, workflow);
    if (owner.userId !== actor.userId) {
      throw new CoreError(
        "forbidden",
        "Only this agent's owner can change it. Other members can run it and read its history.",
      );
    }
    return owner;
  }
}

export function toCompanyAgent(workflow: Workflow): CompanyAgent {
  const step = workflow.steps[0];
  return {
    id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    description: workflow.description,
    instructions: step?.instructions ?? "",
    photoUrl: workflow.slackChannel.avatarUrl,
    model: step?.model ?? "",
    ...(step?.runtimeModel ? { runtimeModel: step.runtimeModel } : {}),
    ...(step?.reasoningEffort ? { reasoningEffort: step.reasoningEffort } : {}),
    status: workflow.status === "active" ? "active" : "paused",
    ownerUserId: workflow.ownerUserId,
    ownerActive: workflow.ownerActive,
    slackEnabled: workflow.slackChannel.enabled,
    triggers: workflow.triggers ?? [],
    lastRunAt: workflow.lastRunAt,
    version: workflow.version,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}
