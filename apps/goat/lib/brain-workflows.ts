import { getDb } from "@opencompany/db/client";
import { goatBrainDocuments } from "@opencompany/db/goat-schema";
import {
  type GoatBrainWorkflow,
  goatBrainWorkflowFromDocument,
  isGoatBrainWorkflowFolder,
  isValidGoatBrainId,
  parseGoatBrainDocument,
} from "@opencompany/goat-brain";
import { and, eq, like, or } from "drizzle-orm";

export type GoatBrainWorkflowCatalogItem = Pick<
  GoatBrainWorkflow,
  "id" | "name" | "description"
> & {
  brainRef: string;
};

export type GoatBrainWorkflowMentionRef = {
  brainRef: string;
  id: string;
};

export class GoatBrainWorkflowMentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoatBrainWorkflowMentionError";
  }
}

export function readGoatBrainWorkflowMentionRef(
  value: unknown,
): { ok: true; mention: GoatBrainWorkflowMentionRef | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, mention: null };
  if (!Array.isArray(value)) return { ok: false, error: "Invalid workflow mentions." };

  const mentions: GoatBrainWorkflowMentionRef[] = [];
  for (const mention of value) {
    if (!mention || typeof mention !== "object" || Array.isArray(mention)) continue;
    const candidate = mention as Record<string, unknown>;
    if (candidate.kind !== "workflow") continue;
    if (
      typeof candidate.brainRef !== "string" ||
      !candidate.brainRef.trim() ||
      typeof candidate.id !== "string" ||
      !isValidGoatBrainId(candidate.id)
    ) {
      return { ok: false, error: "Invalid workflow mention." };
    }
    mentions.push({ brainRef: candidate.brainRef, id: candidate.id });
  }
  const unique = [...new Map(mentions.map((m) => [`${m.brainRef}:${m.id}`, m])).values()];
  if (unique.length > 1) {
    return { ok: false, error: "Mention at most one workflow per message." };
  }
  return { ok: true, mention: unique[0] ?? null };
}

export async function listGoatBrainWorkflowCatalog(
  brainRef: string,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<GoatBrainWorkflowCatalogItem[]> {
  const rows = await db
    .select({
      brainId: goatBrainDocuments.brainId,
      folderPath: goatBrainDocuments.folderPath,
      content: goatBrainDocuments.content,
      format: goatBrainDocuments.format,
    })
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.brainRef, brainRef),
        or(
          eq(goatBrainDocuments.folderPath, "workflows"),
          like(goatBrainDocuments.folderPath, "workflows/%"),
        ),
      ),
    );

  return rows
    .flatMap((row) => {
      if (row.format !== "markdown") return [];
      const workflow = goatBrainWorkflowFromDocument(parseGoatBrainDocument(row.content));
      return workflow && workflow.id === row.brainId && isGoatBrainWorkflowFolder(row.folderPath)
        ? [{ brainRef, id: workflow.id, name: workflow.name, description: workflow.description }]
        : [];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function resolveGoatBrainWorkflowMention(input: {
  activeBrainRef: string | null;
  mention: GoatBrainWorkflowMentionRef;
  db?: ReturnType<typeof getDb>;
}): Promise<GoatBrainWorkflow> {
  if (!input.activeBrainRef) {
    throw new GoatBrainWorkflowMentionError("No active Brain is available for workflow mentions.");
  }
  if (input.mention.brainRef !== input.activeBrainRef) {
    throw new GoatBrainWorkflowMentionError("The selected workflow is not in the active Brain.");
  }

  const rows = await (input.db ?? getDb())
    .select({
      brainId: goatBrainDocuments.brainId,
      folderPath: goatBrainDocuments.folderPath,
      format: goatBrainDocuments.format,
      content: goatBrainDocuments.content,
    })
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.brainRef, input.activeBrainRef),
        eq(goatBrainDocuments.brainId, input.mention.id),
      ),
    );
  for (const row of rows) {
    if (row.format !== "markdown" || !isGoatBrainWorkflowFolder(row.folderPath)) continue;
    const workflow = goatBrainWorkflowFromDocument(parseGoatBrainDocument(row.content));
    if (workflow && workflow.id === row.brainId) return workflow;
  }
  throw new GoatBrainWorkflowMentionError(
    `Workflow "#${input.mention.id}" is unavailable or incomplete.`,
  );
}
