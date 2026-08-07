import type { ParsedBrainDocument } from "./document";
import { BRAIN_EMPTY_TRUTH_PLACEHOLDER } from "./document";
import { isValidBrainId, normalizeBrainFolder } from "./schema";

export const BRAIN_SKILLS_ZONE = "skills";
export const BRAIN_SKILL_NAME_MAX_LENGTH = 64;
export const BRAIN_SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export type BrainSkill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
};

export function isBrainSkillFolder(value: string): boolean {
  const folder = normalizeBrainFolder(value);
  return folder === BRAIN_SKILLS_ZONE || folder.startsWith(`${BRAIN_SKILLS_ZONE}/`);
}

export function brainSkillFromDocument(document: ParsedBrainDocument): BrainSkill | null {
  if (!document.frontmatter.folder || !isBrainSkillFolder(document.frontmatter.folder)) {
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
  if (
    !isValidBrainSkillId(id) ||
    !name ||
    !isValidOptionalBrainSkillDescription(description) ||
    !instructions ||
    instructions === BRAIN_EMPTY_TRUTH_PLACEHOLDER
  ) {
    return null;
  }
  return { id, name, description, instructions };
}

export function serializeBrainSkillMarkdown(skill: BrainSkill): string {
  return [
    "---",
    // Native skill runtimes use the frontmatter name as the invocation id. Keep the human title
    // in Goat's catalog, but materialize the stable, cross-runtime-safe Brain id here.
    `name: ${JSON.stringify(skill.id)}`,
    ...(skill.description ? [`description: ${JSON.stringify(skill.description)}`] : []),
    "---",
    "",
    skill.instructions.trim(),
    "",
  ].join("\n");
}

export function isValidBrainSkillId(value: unknown): value is string {
  return isValidBrainId(value) && value.length <= BRAIN_SKILL_NAME_MAX_LENGTH;
}

function isValidOptionalBrainSkillDescription(value: string) {
  return (
    value.length <= BRAIN_SKILL_DESCRIPTION_MAX_LENGTH &&
    !value.includes("<") &&
    !value.includes(">")
  );
}
