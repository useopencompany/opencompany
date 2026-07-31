import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  type GoatWorkflowStatus,
  type GoatWorkflowStep,
  goatWorkflows,
} from "@opencompany/db/goat-schema";
import {
  GOAT_BRAIN_WORKFLOW_DESCRIPTION_MAX_LENGTH,
  GOAT_BRAIN_WORKFLOW_NAME_MAX_LENGTH,
  isValidGoatBrainId,
  normalizeGoatBrainId,
} from "@opencompany/goat-brain";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { isGoatWorkflowModelToken } from "@/lib/workflow-model-options";

// Workflows are workspace-scoped automations. They used to live as markdown
// documents in a reserved `workflows/` Brain folder; they now have their own
// `goat.workflows` table so "how work happens" is a first-class, company-level
// primitive rather than Brain (knowledge) content. The `#` composer mention
// fires a workflow as a background task on send (see lib/workflow-tasks.ts).

type Db = ReturnType<typeof getDb>;

// `id` is the workspace-unique slug used by composer mentions and task rows.
export type GoatWorkspaceWorkflow = {
  id: string;
  name: string;
  description: string;
  steps: GoatWorkflowStep[];
};

export type GoatWorkflowListItem = {
  slug: string;
  name: string;
  description: string;
  status: GoatWorkflowStatus;
  updatedAt: Date;
};

export type GoatWorkflowCatalogItem = Pick<GoatWorkspaceWorkflow, "id" | "name" | "description">;

export type GoatWorkflowDetail = GoatWorkspaceWorkflow & { status: GoatWorkflowStatus };

export type GoatWorkflowMentionRef = { id: string };

export type GoatWorkflowMutationResult =
  | { ok: true; slug: string }
  | { ok: false; message: string };

export class GoatWorkflowMentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoatWorkflowMentionError";
  }
}

export function readGoatWorkflowMentionRef(
  value: unknown,
): { ok: true; mention: GoatWorkflowMentionRef | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, mention: null };
  if (!Array.isArray(value)) return { ok: false, error: "Invalid workflow mentions." };

  const mentions: GoatWorkflowMentionRef[] = [];
  for (const mention of value) {
    if (!mention || typeof mention !== "object" || Array.isArray(mention)) continue;
    const candidate = mention as Record<string, unknown>;
    if (candidate.kind !== "workflow") continue;
    if (typeof candidate.id !== "string" || !isValidGoatBrainId(candidate.id)) {
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

export async function listGoatWorkflowCatalog(
  workspaceId: string,
  db: Db = getDb(),
): Promise<GoatWorkflowCatalogItem[]> {
  const rows = await db
    .select({
      slug: goatWorkflows.slug,
      name: goatWorkflows.name,
      description: goatWorkflows.description,
      instructions: goatWorkflows.instructions,
      model: goatWorkflows.model,
      steps: goatWorkflows.steps,
    })
    .from(goatWorkflows)
    .where(
      and(
        eq(goatWorkflows.workspaceId, workspaceId),
        eq(goatWorkflows.status, "active"),
        isNull(goatWorkflows.archivedAt),
      ),
    )
    .orderBy(asc(goatWorkflows.name));

  const catalog: GoatWorkflowCatalogItem[] = [];
  for (const row of rows) {
    const steps = goatWorkflowStepsWithLegacyFallback(row);
    if (steps.length === 0 || steps.some((step) => !step.instructions.trim())) continue;
    catalog.push({ id: row.slug, name: row.name, description: row.description });
  }
  return catalog;
}

export async function listGoatWorkflows(
  workspaceId: string,
  db: Db = getDb(),
): Promise<GoatWorkflowListItem[]> {
  const rows = await db
    .select({
      slug: goatWorkflows.slug,
      name: goatWorkflows.name,
      description: goatWorkflows.description,
      status: goatWorkflows.status,
      updatedAt: goatWorkflows.updatedAt,
    })
    .from(goatWorkflows)
    .where(and(eq(goatWorkflows.workspaceId, workspaceId), isNull(goatWorkflows.archivedAt)))
    .orderBy(desc(goatWorkflows.updatedAt));
  return rows;
}

export async function getGoatWorkflow(
  workspaceId: string,
  slug: string,
  db: Db = getDb(),
): Promise<GoatWorkflowDetail | null> {
  const [row] = await db
    .select({
      slug: goatWorkflows.slug,
      name: goatWorkflows.name,
      description: goatWorkflows.description,
      instructions: goatWorkflows.instructions,
      model: goatWorkflows.model,
      steps: goatWorkflows.steps,
      status: goatWorkflows.status,
    })
    .from(goatWorkflows)
    .where(
      and(
        eq(goatWorkflows.workspaceId, workspaceId),
        eq(goatWorkflows.slug, slug),
        isNull(goatWorkflows.archivedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.slug,
    name: row.name,
    description: row.description,
    steps: goatWorkflowStepsWithLegacyFallback(row),
    status: row.status,
  };
}

export async function resolveGoatWorkflowMention(input: {
  workspaceId: string | null;
  mention: GoatWorkflowMentionRef;
  db?: Db;
}): Promise<GoatWorkspaceWorkflow> {
  if (!input.workspaceId) {
    throw new GoatWorkflowMentionError("No active workspace is available for workflow mentions.");
  }
  const workflow = await getGoatWorkflow(input.workspaceId, input.mention.id, input.db ?? getDb());
  if (
    !workflow ||
    workflow.status !== "active" ||
    workflow.steps.length === 0 ||
    workflow.steps.some((step) => !step.instructions.trim())
  ) {
    throw new GoatWorkflowMentionError(
      `Workflow "#${input.mention.id}" is unavailable or incomplete.`,
    );
  }
  return workflow;
}

// --- Authoring (mutations) ---------------------------------------------------

export function validateGoatWorkflowFields(input: {
  name: string;
  description: string;
  steps: GoatWorkflowStep[];
  status?: GoatWorkflowStatus;
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
    if (model && !isGoatWorkflowModelToken(model)) {
      return "That workflow model is not available.";
    }
  }
  return null;
}

export async function createGoatWorkflow(input: {
  workspaceId: string;
  createdByWorkosId: string;
  name: string;
  description?: string;
}): Promise<GoatWorkflowMutationResult> {
  const steps = [emptyGoatWorkflowStep()];
  const invalid = validateGoatWorkflowFields({
    name: input.name,
    description: input.description ?? "",
    steps,
  });
  if (invalid) return { ok: false, message: invalid };
  const db = getDb();
  const slug = await uniqueGoatWorkflowSlug(db, input.workspaceId, input.name);
  await db.insert(goatWorkflows).values({
    id: `goat_wf_${randomUUID()}`,
    workspaceId: input.workspaceId,
    slug,
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    instructions: "",
    model: "",
    steps,
    status: "active",
    createdByWorkosId: input.createdByWorkosId,
  });
  return { ok: true, slug };
}

export async function updateGoatWorkflow(input: {
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  steps: GoatWorkflowStep[];
  status: GoatWorkflowStatus;
}): Promise<GoatWorkflowMutationResult> {
  const invalid = validateGoatWorkflowFields(input);
  if (invalid) return { ok: false, message: invalid };
  const steps = input.steps.map((step) => ({
    id: step.id,
    title: step.title,
    model: step.model.trim(),
    instructions: step.instructions,
  }));
  const db = getDb();
  const result = await db
    .update(goatWorkflows)
    .set({
      name: input.name.trim(),
      description: input.description.trim(),
      steps,
      status: input.status,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(goatWorkflows.workspaceId, input.workspaceId),
        eq(goatWorkflows.slug, input.slug),
        isNull(goatWorkflows.archivedAt),
      ),
    )
    .returning({ slug: goatWorkflows.slug });
  if (result.length === 0) return { ok: false, message: "Workflow not found." };
  return { ok: true, slug: input.slug };
}

export function goatWorkflowStepsWithLegacyFallback(input: {
  slug: string;
  steps: GoatWorkflowStep[];
  instructions: string;
  model: string;
}): GoatWorkflowStep[] {
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

export async function archiveGoatWorkflow(input: {
  workspaceId: string;
  slug: string;
}): Promise<GoatWorkflowMutationResult> {
  const db = getDb();
  const result = await db
    .update(goatWorkflows)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(goatWorkflows.workspaceId, input.workspaceId),
        eq(goatWorkflows.slug, input.slug),
        isNull(goatWorkflows.archivedAt),
      ),
    )
    .returning({ slug: goatWorkflows.slug });
  if (result.length === 0) return { ok: false, message: "Workflow not found." };
  return { ok: true, slug: input.slug };
}

function emptyGoatWorkflowStep(): GoatWorkflowStep {
  return {
    id: `step-${randomUUID()}`,
    title: "",
    model: "",
    instructions: "",
  };
}

async function uniqueGoatWorkflowSlug(db: Db, workspaceId: string, name: string): Promise<string> {
  const base = normalizeGoatBrainId(name).slice(0, 64).replace(/-+$/g, "") || "workflow";
  const rows = await db
    .select({ slug: goatWorkflows.slug })
    .from(goatWorkflows)
    .where(and(eq(goatWorkflows.workspaceId, workspaceId), isNull(goatWorkflows.archivedAt)));
  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(base)) return base;
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${base.slice(0, 60)}-${number}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 55)}-${randomUUID().slice(0, 8)}`;
}
