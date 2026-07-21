import type { ParsedGoatBrainDocument } from "./document";
import { GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER } from "./document";
import { isValidGoatBrainId, normalizeGoatBrainFolder } from "./schema";

export const GOAT_BRAIN_SKILLS_ZONE = "skills";
export const GOAT_BRAIN_SKILL_NAME_MAX_LENGTH = 64;
export const GOAT_BRAIN_SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export type GoatBrainSkill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
};

export function isGoatBrainSkillFolder(value: string): boolean {
  const folder = normalizeGoatBrainFolder(value);
  return folder === GOAT_BRAIN_SKILLS_ZONE || folder.startsWith(`${GOAT_BRAIN_SKILLS_ZONE}/`);
}

export function goatBrainSkillFromDocument(
  document: ParsedGoatBrainDocument,
): GoatBrainSkill | null {
  if (!document.frontmatter.folder || !isGoatBrainSkillFolder(document.frontmatter.folder)) {
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
    !isValidGoatBrainSkillId(id) ||
    !name ||
    !isValidOptionalGoatBrainSkillDescription(description) ||
    !instructions ||
    instructions === GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER
  ) {
    return null;
  }
  return { id, name, description, instructions };
}

export function serializeGoatBrainSkillMarkdown(skill: GoatBrainSkill): string {
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

export function isValidGoatBrainSkillId(value: unknown): value is string {
  return isValidGoatBrainId(value) && value.length <= GOAT_BRAIN_SKILL_NAME_MAX_LENGTH;
}

function isValidOptionalGoatBrainSkillDescription(value: string) {
  return (
    value.length <= GOAT_BRAIN_SKILL_DESCRIPTION_MAX_LENGTH &&
    !value.includes("<") &&
    !value.includes(">")
  );
}
