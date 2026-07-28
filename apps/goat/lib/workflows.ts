import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { type GoatWorkflowStatus, goatWorkflows } from "@opencompany/db/goat-schema";
import {
  GOAT_BRAIN_WORKFLOW_DESCRIPTION_MAX_LENGTH,
  GOAT_BRAIN_WORKFLOW_NAME_MAX_LENGTH,
  type GoatBrainWorkflow,
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

// The content shape carried through mentions and task compilation. `id` holds
// the workspace-unique slug (the `#` handle and `tasks.workflow_id`) — kept
// named `id` so it stays drop-in with the former Brain-doc shape
// (`GoatBrainWorkflow`).
export type GoatWorkspaceWorkflow = GoatBrainWorkflow;

export type GoatWorkflowListItem = {
  slug: string;
  name: string;
  description: string;
  model: string;
  status: GoatWorkflowStatus;
  updatedAt: Date;
};

export type GoatWorkflowCatalogItem = Pick<GoatWorkspaceWorkflow, "id" | "name" | "description">;

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
  const unique = [...new Map(mentions.map((m) => [m.id, m])).values()];
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
    })
    .from(goatWorkflows)
    .where(and(eq(goatWorkflows.workspaceId, workspaceId), isNull(goatWorkflows.archivedAt)))
    .orderBy(asc(goatWorkflows.name));

  return rows.map((row) => ({ id: row.slug, name: row.name, description: row.description }));
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
      model: goatWorkflows.model,
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
): Promise<GoatWorkspaceWorkflow | null> {
  const [row] = await db
    .select({
      slug: goatWorkflows.slug,
      name: goatWorkflows.name,
      description: goatWorkflows.description,
      instructions: goatWorkflows.instructions,
      model: goatWorkflows.model,
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
    instructions: row.instructions,
    model: row.model,
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
  if (!workflow || !workflow.instructions.trim()) {
    throw new GoatWorkflowMentionError(
      `Workflow "#${input.mention.id}" is unavailable or incomplete.`,
    );
  }
  return workflow;
}

// --- Authoring (mutations) ---------------------------------------------------

function validateGoatWorkflowFields(input: { name: string; description: string }): string | null {
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
  return null;
}

export async function createGoatWorkflow(input: {
  workspaceId: string;
  createdByWorkosId: string;
  name: string;
  description?: string;
}): Promise<GoatWorkflowMutationResult> {
  const invalid = validateGoatWorkflowFields({
    name: input.name,
    description: input.description ?? "",
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
    status: "draft",
    createdByWorkosId: input.createdByWorkosId,
  });
  return { ok: true, slug };
}

export async function updateGoatWorkflow(input: {
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  // Model mention token ("kimi-k2.6", "codex", ...); undefined keeps the stored
  // value, "" clears it back to the default.
  model?: string;
  status?: GoatWorkflowStatus;
}): Promise<GoatWorkflowMutationResult> {
  const invalid = validateGoatWorkflowFields(input);
  if (invalid) return { ok: false, message: invalid };
  const model = input.model?.trim();
  if (model && !isGoatWorkflowModelToken(model)) {
    return { ok: false, message: "That workflow model is not available." };
  }
  const db = getDb();
  const result = await db
    .update(goatWorkflows)
    .set({
      name: input.name.trim(),
      description: input.description.trim(),
      instructions: input.instructions,
      ...(input.model !== undefined ? { model: model ?? "" } : {}),
      ...(input.status ? { status: input.status } : {}),
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

async function uniqueGoatWorkflowSlug(db: Db, workspaceId: string, name: string): Promise<string> {
  const base = normalizeGoatBrainId(name).slice(0, 64).replace(/-+$/g, "") || "workflow";
  const rows = await db
    .select({ slug: goatWorkflows.slug })
    .from(goatWorkflows)
    .where(and(eq(goatWorkflows.workspaceId, workspaceId), isNull(goatWorkflows.archivedAt)));
  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 60)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 55)}-${randomUUID().slice(0, 8)}`;
}
