import { randomUUID } from "node:crypto";
import {
  isCodexReasoningEffort,
  isValidFiveFieldCron,
  nextCronRunAt,
  normalizeScheduleTimezone,
} from "@opencompany/agent-runtime";
import {
  GOAT_BRAIN_WORKFLOW_DESCRIPTION_MAX_LENGTH,
  GOAT_BRAIN_WORKFLOW_NAME_MAX_LENGTH,
  isValidBrainId,
  normalizeBrainId,
} from "@opencompany/brain";
import { getDb } from "@opencompany/db/client";
import {
  type HarnessSpec,
  type WorkflowStatus,
  type WorkflowStep,
  type WorkflowTrigger,
  workflows,
} from "@opencompany/db/schema";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  GOAT_WORKFLOW_MODEL_OPTIONS,
  isWorkflowCloudRuntime,
  isWorkflowModelToken,
  isWorkflowRuntimeModel,
  workflowStepSettings,
} from "@/lib/workflow-model-options";
import {
  DEFAULT_GOAT_WORKFLOW_SCHEDULE_CRON,
  DEFAULT_GOAT_WORKFLOW_SCHEDULE_PROMPT,
  DEFAULT_GOAT_WORKFLOW_SCHEDULE_TIMEZONE,
} from "@/lib/workflow-schedule-defaults";

// Workflows are workspace-scoped automations. They used to live as markdown
// documents in a reserved `workflows/` Brain folder; they now have their own
// `goat.workflows` table so "how work happens" is a first-class, company-level
// primitive rather than Brain (knowledge) content. The `#` composer mention
// fires a workflow as a background task on send (see lib/workflow-tasks.ts).

type Db = ReturnType<typeof getDb>;

export { DEFAULT_GOAT_WORKFLOW_SCHEDULE_CRON, DEFAULT_GOAT_WORKFLOW_SCHEDULE_PROMPT };

const GOAT_WORKFLOW_SCHEDULE_PROMPT_MAX_LENGTH = 10_000;

export type WorkflowTriggerInput =
  | { type: "manual" }
  | {
      type: "schedule";
      cron: string;
      timezone?: string | null;
      prompt?: string | null;
    };

export type WorkflowTriggerDetail =
  | { type: "manual" }
  | {
      type: "schedule";
      cron: string;
      timezone: string;
      prompt: string;
      enabled: boolean;
      lastRunAt: Date | null;
      nextRunAt: Date | null;
    };

// `id` is the workspace-unique slug used by composer mentions and task rows.
export type WorkspaceWorkflow = {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
};

export type WorkflowListItem = {
  slug: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  trigger: WorkflowTriggerDetail;
  updatedAt: Date;
};

export type WorkflowCatalogItem = Pick<WorkspaceWorkflow, "id" | "name" | "description">;

export type WorkflowDetail = WorkspaceWorkflow & {
  status: WorkflowStatus;
  trigger: WorkflowTriggerDetail;
};

export type WorkflowMentionRef = { id: string };

export type WorkflowMutationResult = { ok: true; slug: string } | { ok: false; message: string };

export class WorkflowMentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowMentionError";
  }
}

export function readWorkflowMentionRef(
  value: unknown,
): { ok: true; mention: WorkflowMentionRef | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, mention: null };
  if (!Array.isArray(value)) return { ok: false, error: "Invalid workflow mentions." };

  const mentions: WorkflowMentionRef[] = [];
  for (const mention of value) {
    if (!mention || typeof mention !== "object" || Array.isArray(mention)) continue;
    const candidate = mention as Record<string, unknown>;
    if (candidate.kind !== "workflow") continue;
    if (typeof candidate.id !== "string" || !isValidBrainId(candidate.id)) {
      return { ok: false, error: "Invalid workflow mention." };
    }
    mentions.push({ id: candidate.id });
  }
  const unique = [...new Map(mentions.map((mention) => [mention.id, mention])).values()];
  if (unique.length > 1) {
    return { ok: false, error: "Mention at most one workflow per message." };
  }
  return { ok: true, mention: unique[0] ?? null };
}

export async function listWorkflowCatalog(
  workspaceId: string,
  db: Db = getDb(),
): Promise<WorkflowCatalogItem[]> {
  const rows = await db
    .select({
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      instructions: workflows.instructions,
      model: workflows.model,
      steps: workflows.steps,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        eq(workflows.status, "active"),
        isNull(workflows.archivedAt),
      ),
    )
    .orderBy(asc(workflows.name));

  const catalog: WorkflowCatalogItem[] = [];
  for (const row of rows) {
    const steps = workflowStepsWithLegacyFallback(row);
    if (steps.length === 0 || steps.some((step) => !step.instructions.trim())) continue;
    catalog.push({ id: row.slug, name: row.name, description: row.description });
  }
  return catalog;
}

export async function listWorkflows(
  workspaceId: string,
  db: Db = getDb(),
): Promise<WorkflowListItem[]> {
  const rows = await db
    .select({
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      status: workflows.status,
      trigger: workflows.trigger,
      scheduleCron: workflows.scheduleCron,
      scheduleTimezone: workflows.scheduleTimezone,
      schedulePrompt: workflows.schedulePrompt,
      scheduleEnabled: workflows.scheduleEnabled,
      scheduleLastRunAt: workflows.scheduleLastRunAt,
      scheduleNextRunAt: workflows.scheduleNextRunAt,
      updatedAt: workflows.updatedAt,
    })
    .from(workflows)
    .where(and(eq(workflows.workspaceId, workspaceId), isNull(workflows.archivedAt)))
    .orderBy(desc(workflows.updatedAt));
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    trigger: workflowTriggerFromRow(row),
    updatedAt: row.updatedAt,
  }));
}

export async function getWorkflow(
  workspaceId: string,
  slug: string,
  db: Db = getDb(),
): Promise<WorkflowDetail | null> {
  const [row] = await db
    .select({
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      instructions: workflows.instructions,
      model: workflows.model,
      steps: workflows.steps,
      trigger: workflows.trigger,
      scheduleCron: workflows.scheduleCron,
      scheduleTimezone: workflows.scheduleTimezone,
      schedulePrompt: workflows.schedulePrompt,
      scheduleEnabled: workflows.scheduleEnabled,
      scheduleLastRunAt: workflows.scheduleLastRunAt,
      scheduleNextRunAt: workflows.scheduleNextRunAt,
      status: workflows.status,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        eq(workflows.slug, slug),
        isNull(workflows.archivedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.slug,
    name: row.name,
    description: row.description,
    steps: workflowStepsWithLegacyFallback(row),
    status: row.status,
    trigger: workflowTriggerFromRow(row),
  };
}

export async function resolveWorkflowMention(input: {
  workspaceId: string | null;
  mention: WorkflowMentionRef;
  db?: Db;
}): Promise<WorkspaceWorkflow> {
  if (!input.workspaceId) {
    throw new WorkflowMentionError("No active workspace is available for workflow mentions.");
  }
  const workflow = await getWorkflow(input.workspaceId, input.mention.id, input.db ?? getDb());
  if (
    !workflow ||
    workflow.status !== "active" ||
    workflow.steps.length === 0 ||
    workflow.steps.some((step) => !step.instructions.trim())
  ) {
    throw new WorkflowMentionError(`Workflow "#${input.mention.id}" is unavailable or incomplete.`);
  }
  return workflow;
}

// --- Authoring (mutations) ---------------------------------------------------

export function validateWorkflowFields(input: {
  name: string;
  description: string;
  steps: WorkflowStep[];
  status?: WorkflowStatus;
  trigger?: WorkflowTriggerInput;
}): string | null {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) return "Workflow name cannot be empty.";
  if (name.length > GOAT_BRAIN_WORKFLOW_NAME_MAX_LENGTH) {
    return `Workflow names must be ${GOAT_BRAIN_WORKFLOW_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (description.length > GOAT_BRAIN_WORKFLOW_DESCRIPTION_MAX_LENGTH) {
    return `Workflow descriptions must be ${GOAT_BRAIN_WORKFLOW_DESCRIPTION_MAX_LENGTH} characters or fewer.`;
  }
  if (description.includes("<") || description.includes(">")) {
    return 'Workflow descriptions cannot contain "<" or ">".';
  }
  if (input.steps.length === 0) return "Add at least one workflow step.";
  if (input.steps.length > 20) return "Workflows can have at most 20 steps.";

  const stepIds = new Set<string>();
  for (const step of input.steps) {
    if (!step.id.trim() || step.id.length > 200) return "Workflow step IDs are invalid.";
    if (stepIds.has(step.id)) return "Workflow step IDs must be unique.";
    stepIds.add(step.id);
    if (step.title.length > 120) return "Workflow step titles must be 120 characters or fewer.";
    if (step.instructions.length > 20_000) {
      return "Workflow step instructions must be 20,000 characters or fewer.";
    }
    const model = step.model.trim();
    if (model && !isWorkflowModelToken(model)) {
      return "That workflow model is not available.";
    }
    const option = GOAT_WORKFLOW_MODEL_OPTIONS.find((candidate) => candidate.token === model);
    if (option && isWorkflowCloudRuntime(option.engine)) {
      const runtimeModelValue = step.runtimeModel as unknown;
      const runtimeModel = typeof runtimeModelValue === "string" ? runtimeModelValue.trim() : "";
      if (runtimeModel && !isWorkflowRuntimeModel(option.engine, runtimeModel)) {
        return "That workflow coding model is not available.";
      }
      const reasoningEffort = step.reasoningEffort as unknown;
      if (
        reasoningEffort !== undefined &&
        reasoningEffort !== "" &&
        (typeof reasoningEffort !== "string" || !isCodexReasoningEffort(reasoningEffort))
      ) {
        return "That workflow effort level is not available.";
      }
    }
  }
  const trigger = normalizeWorkflowTriggerInput(input.trigger);
  if (!trigger.ok) return trigger.message;
  return null;
}

export async function createWorkflow(input: {
  workspaceId: string;
  createdByWorkosId: string;
  name: string;
  description?: string;
}): Promise<WorkflowMutationResult> {
  const steps = [emptyWorkflowStep()];
  const invalid = validateWorkflowFields({
    name: input.name,
    description: input.description ?? "",
    steps,
  });
  if (invalid) return { ok: false, message: invalid };
  const db = getDb();
  const slug = await uniqueWorkflowSlug(db, input.workspaceId, input.name);
  await db.insert(workflows).values({
    id: `goat_wf_${randomUUID()}`,
    workspaceId: input.workspaceId,
    slug,
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    instructions: "",
    model: "",
    steps,
    trigger: "manual",
    scheduleEnabled: false,
    scheduleCron: null,
    scheduleTimezone: DEFAULT_GOAT_WORKFLOW_SCHEDULE_TIMEZONE,
    schedulePrompt: "",
    scheduleHarnessSpec: null,
    scheduleUserWorkosId: null,
    scheduleNextRunAt: null,
    status: "active",
    createdByWorkosId: input.createdByWorkosId,
  });
  return { ok: true, slug };
}

export async function updateWorkflow(input: {
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  status: WorkflowStatus;
  trigger?: WorkflowTriggerInput;
  scheduleHarnessSpec?: HarnessSpec | null;
  scheduleUserWorkosId?: string | null;
  now?: Date;
}): Promise<WorkflowMutationResult> {
  const invalid = validateWorkflowFields(input);
  if (invalid) return { ok: false, message: invalid };
  const trigger = normalizeWorkflowTriggerInput(input.trigger, input.now);
  if (!trigger.ok) return { ok: false, message: trigger.message };
  if (trigger.value.type === "schedule" && input.status === "active") {
    if (!input.scheduleUserWorkosId?.trim()) {
      return { ok: false, message: "Scheduled workflows need a user to run as." };
    }
    if (!input.scheduleHarnessSpec) {
      return { ok: false, message: "Scheduled workflows need runnable instructions." };
    }
  }
  const steps = input.steps.map((step) => ({
    id: step.id,
    title: step.title,
    ...workflowStepSettings(step),
    instructions: step.instructions,
  }));
  const scheduleNextRunAt =
    trigger.value.type === "schedule" && input.status === "active"
      ? nextCronRunAt(trigger.value.cron, trigger.value.timezone, input.now)
      : null;
  const db = getDb();
  const result = await db
    .update(workflows)
    .set({
      name: input.name.trim(),
      description: input.description.trim(),
      steps,
      trigger: trigger.value.type,
      scheduleCron: trigger.value.type === "schedule" ? trigger.value.cron : null,
      scheduleTimezone:
        trigger.value.type === "schedule"
          ? trigger.value.timezone
          : DEFAULT_GOAT_WORKFLOW_SCHEDULE_TIMEZONE,
      schedulePrompt: trigger.value.type === "schedule" ? trigger.value.prompt : "",
      scheduleEnabled: trigger.value.type === "schedule",
      scheduleUserWorkosId:
        trigger.value.type === "schedule" ? input.scheduleUserWorkosId?.trim() || null : null,
      scheduleHarnessSpec:
        trigger.value.type === "schedule" ? (input.scheduleHarnessSpec ?? null) : null,
      scheduleNextRunAt,
      status: input.status,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.slug, input.slug),
        isNull(workflows.archivedAt),
      ),
    )
    .returning({ slug: workflows.slug });
  if (result.length === 0) return { ok: false, message: "Workflow not found." };
  return { ok: true, slug: input.slug };
}

export function workflowStepsWithLegacyFallback(input: {
  slug: string;
  steps: WorkflowStep[];
  instructions: string;
  model: string;
}): WorkflowStep[] {
  if (input.steps.length > 0) return input.steps;
  if (!input.instructions.trim() && !input.model.trim()) return [];
  return [
    {
      id: `step-${input.slug.slice(0, 64)}`,
      title: "",
      model: input.model,
      instructions: input.instructions,
    },
  ];
}

export function workflowTriggerFromRow(input: {
  trigger: WorkflowTrigger;
  scheduleCron: string | null;
  scheduleTimezone: string;
  schedulePrompt: string;
  scheduleEnabled: boolean;
  scheduleLastRunAt: Date | null;
  scheduleNextRunAt: Date | null;
}): WorkflowTriggerDetail {
  if (input.trigger !== "schedule") return { type: "manual" };
  return {
    type: "schedule",
    cron: input.scheduleCron?.trim() || DEFAULT_GOAT_WORKFLOW_SCHEDULE_CRON,
    timezone: normalizeScheduleTimezone(input.scheduleTimezone),
    prompt: input.schedulePrompt.trim() || DEFAULT_GOAT_WORKFLOW_SCHEDULE_PROMPT,
    enabled: input.scheduleEnabled,
    lastRunAt: input.scheduleLastRunAt,
    nextRunAt: input.scheduleNextRunAt,
  };
}

function normalizeWorkflowTriggerInput(
  input: WorkflowTriggerInput | undefined,
  now = new Date(),
):
  | {
      ok: true;
      value:
        | { type: "manual" }
        | { type: "schedule"; cron: string; timezone: string; prompt: string };
    }
  | { ok: false; message: string } {
  if (!input || input.type === "manual") return { ok: true, value: { type: "manual" } };
  if (input.type !== "schedule") return { ok: false, message: "That workflow trigger is invalid." };

  const cron = input.cron.trim().replace(/\s+/g, " ");
  const timezone = normalizeScheduleTimezone(input.timezone);
  const prompt = input.prompt?.trim() || DEFAULT_GOAT_WORKFLOW_SCHEDULE_PROMPT;

  if (prompt.length > GOAT_WORKFLOW_SCHEDULE_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      message: `Schedule task requests must be ${GOAT_WORKFLOW_SCHEDULE_PROMPT_MAX_LENGTH.toLocaleString()} characters or fewer.`,
    };
  }
  if (!isValidFiveFieldCron(cron, timezone) || !nextCronRunAt(cron, timezone, now)) {
    return { ok: false, message: "Schedule triggers need a valid 5-field cron expression." };
  }

  return { ok: true, value: { type: "schedule", cron, timezone, prompt } };
}

export async function archiveWorkflow(input: {
  workspaceId: string;
  slug: string;
}): Promise<WorkflowMutationResult> {
  const db = getDb();
  const result = await db
    .update(workflows)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.slug, input.slug),
        isNull(workflows.archivedAt),
      ),
    )
    .returning({ slug: workflows.slug });
  if (result.length === 0) return { ok: false, message: "Workflow not found." };
  return { ok: true, slug: input.slug };
}

function emptyWorkflowStep(): WorkflowStep {
  return {
    id: `step-${randomUUID()}`,
    title: "",
    model: "",
    instructions: "",
  };
}

async function uniqueWorkflowSlug(db: Db, workspaceId: string, name: string): Promise<string> {
  const base = normalizeBrainId(name).slice(0, 64).replace(/-+$/g, "") || "workflow";
  const rows = await db
    .select({ slug: workflows.slug })
    .from(workflows)
    .where(and(eq(workflows.workspaceId, workspaceId), isNull(workflows.archivedAt)));
  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(base)) return base;
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${base.slice(0, 60)}-${number}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 55)}-${randomUUID().slice(0, 8)}`;
}
