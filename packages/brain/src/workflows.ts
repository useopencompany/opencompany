import type { ParsedBrainDocument } from "./document";
import { GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER } from "./document";
import { isValidBrainId, normalizeBrainFolder } from "./schema";

export const GOAT_BRAIN_WORKFLOWS_ZONE = "workflows";
export const GOAT_BRAIN_WORKFLOW_NAME_MAX_LENGTH = 64;
export const GOAT_BRAIN_WORKFLOW_DESCRIPTION_MAX_LENGTH = 1024;

export type BrainWorkflow = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  // Model/engine mention token (e.g. "kimi-k2.6", "codex") from frontmatter;
  // empty when the workflow has not picked a model explicitly.
  model: string;
};

export function isBrainWorkflowFolder(value: string): boolean {
  const folder = normalizeBrainFolder(value);
  return folder === GOAT_BRAIN_WORKFLOWS_ZONE || folder.startsWith(`${GOAT_BRAIN_WORKFLOWS_ZONE}/`);
}

export function brainWorkflowFromDocument(document: ParsedBrainDocument): BrainWorkflow | null {
  if (!document.frontmatter.folder || !isBrainWorkflowFolder(document.frontmatter.folder)) {
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
    !isValidBrainWorkflowId(id) ||
    !name ||
    !isValidOptionalBrainWorkflowDescription(description) ||
    !instructions ||
    instructions === GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER
  ) {
    return null;
  }
  return { id, name, description, instructions, model };
}

export function isValidBrainWorkflowId(value: unknown): value is string {
  return isValidBrainId(value) && value.length <= GOAT_BRAIN_WORKFLOW_NAME_MAX_LENGTH;
}

function isValidOptionalBrainWorkflowDescription(value: string) {
  return (
    value.length <= GOAT_BRAIN_WORKFLOW_DESCRIPTION_MAX_LENGTH &&
    !value.includes("<") &&
    !value.includes(">")
  );
}
