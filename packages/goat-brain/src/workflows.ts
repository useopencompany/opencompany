import type { ParsedGoatBrainDocument } from "./document";
import { GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER } from "./document";
import { isValidGoatBrainId, normalizeGoatBrainFolder } from "./schema";

export const GOAT_BRAIN_WORKFLOWS_ZONE = "workflows";
export const GOAT_BRAIN_WORKFLOW_NAME_MAX_LENGTH = 64;
export const GOAT_BRAIN_WORKFLOW_DESCRIPTION_MAX_LENGTH = 1024;

export type GoatBrainWorkflow = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  // Model/engine mention token (e.g. "kimi-k2.6", "codex") from frontmatter;
  // empty when the workflow has not picked a model explicitly.
  model: string;
};

export function isGoatBrainWorkflowFolder(value: string): boolean {
  const folder = normalizeGoatBrainFolder(value);
  return folder === GOAT_BRAIN_WORKFLOWS_ZONE || folder.startsWith(`${GOAT_BRAIN_WORKFLOWS_ZONE}/`);
}

export function goatBrainWorkflowFromDocument(
  document: ParsedGoatBrainDocument,
): GoatBrainWorkflow | null {
  if (!document.frontmatter.folder || !isGoatBrainWorkflowFolder(document.frontmatter.folder)) {
    return null;
  }
  if (document.frontmatter.kind !== "page") return null;
  if (document.frontmatter.status !== "draft" && document.frontmatter.status !== "active") {
    return null;
  }
  const id = document.frontmatter.id?.trim() ?? "";
  const name = (document.frontmatter.title ?? document.title).trim();
  const description = document.frontmatter.description?.trim() ?? "";
  const instructions = document.compiledTruth.trim();
  const model = document.frontmatter.model?.trim() ?? "";
  if (
    !isValidGoatBrainWorkflowId(id) ||
    !name ||
    !isValidOptionalGoatBrainWorkflowDescription(description) ||
    !instructions ||
    instructions === GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER
  ) {
    return null;
  }
  return { id, name, description, instructions, model };
}

export function isValidGoatBrainWorkflowId(value: unknown): value is string {
  return isValidGoatBrainId(value) && value.length <= GOAT_BRAIN_WORKFLOW_NAME_MAX_LENGTH;
}

function isValidOptionalGoatBrainWorkflowDescription(value: string) {
  return (
    value.length <= GOAT_BRAIN_WORKFLOW_DESCRIPTION_MAX_LENGTH &&
    !value.includes("<") &&
    !value.includes(">")
  );
}
