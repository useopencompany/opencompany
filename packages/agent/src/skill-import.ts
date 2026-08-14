import {
  createGitHubSkillFetcher,
  resolveSkill,
  SkillResolverError,
  slugifySkillName,
} from "@opencompany/agent-runtime";
import {
  BRAIN_SKILL_DESCRIPTION_MAX_LENGTH,
  BRAIN_SKILL_NAME_MAX_LENGTH,
} from "@opencompany/brain";
import {
  CoreError,
  type SkillImportPreview,
  type SkillImportResolver,
  type SkillImportSource,
} from "@opencompany/core";

export function createSkillImportResolver(): SkillImportResolver {
  return { resolve: resolveSkillImport };
}

export async function resolveSkillImport(input: {
  url: string;
  selectedPath?: string;
}): Promise<SkillImportPreview> {
  const result = await resolveSkillOrThrow(input);
  if (result.status === "ambiguous") {
    const candidates = result.candidates.filter(
      (candidate) =>
        candidate.path.length <= 512 &&
        candidate.name.trim().length > 0 &&
        candidate.name.length <= BRAIN_SKILL_NAME_MAX_LENGTH &&
        candidate.description.length <= BRAIN_SKILL_DESCRIPTION_MAX_LENGTH,
    );
    if (candidates.length === 0) {
      throw new CoreError(
        "invalid_argument",
        "No valid opencompany Skills were found at that source.",
      );
    }
    return {
      status: "ambiguous",
      candidates: candidates.map((candidate) => ({
        path: candidate.path,
        name: candidate.name,
        description: candidate.description,
      })),
      source: result.source,
    };
  }
  const skill = result.skill;
  const skillMarkdown = skill.files.find((file) => file.path === "SKILL.md");
  if (!skillMarkdown) {
    throw new CoreError("invalid_argument", "Resolved skill is missing its SKILL.md content.");
  }
  const instructions = extractSkillMarkdownBody(skillMarkdown.content);
  validateSkill(skill.name, skill.description, instructions);
  validateResolvedSource(skill.source, skill.resolvedCommit, skill.integrity);

  return {
    status: "resolved",
    proposedSlug: slugifySkillName(skill.name) || "skill",
    name: skill.name,
    description: skill.description,
    instructions,
    source: skill.source satisfies SkillImportSource,
    resolvedCommit: skill.resolvedCommit,
    integrity: skill.integrity,
    extraFiles: skill.files
      .filter((file) => file.path !== "SKILL.md" && file.path.length <= 512)
      .map((file) => file.path),
  };
}

function validateResolvedSource(
  source: SkillImportSource,
  resolvedCommit: string,
  integrity: string,
) {
  if (
    source.url.length > 2_048 ||
    source.ref.length > 256 ||
    source.path.length > 512 ||
    !/^[0-9a-f]{40}$/iu.test(resolvedCommit) ||
    !/^sha256:[0-9a-f]{64}$/iu.test(integrity)
  ) {
    throw new CoreError("invalid_argument", "The resolved Skill source is invalid.");
  }
}

function validateSkill(name: string, description: string, instructions: string) {
  if (!name.trim() || name.length > BRAIN_SKILL_NAME_MAX_LENGTH) {
    throw new CoreError(
      "invalid_argument",
      `Skill names must be ${BRAIN_SKILL_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (
    description.length > BRAIN_SKILL_DESCRIPTION_MAX_LENGTH ||
    description.includes("<") ||
    description.includes(">")
  ) {
    throw new CoreError("invalid_argument", "The Skill description is invalid.");
  }
  if (!instructions.trim()) {
    throw new CoreError("invalid_argument", "The imported Skill has no instructions.");
  }
}

async function resolveSkillOrThrow(input: { url: string; selectedPath?: string }) {
  try {
    return await resolveSkill({
      url: input.url,
      fetcher: createGitHubSkillFetcher(),
      ...(input.selectedPath !== undefined ? { selectedPath: input.selectedPath } : {}),
    });
  } catch (error) {
    if (error instanceof SkillResolverError) {
      throw new CoreError("invalid_argument", error.message);
    }
    throw new CoreError(
      "unavailable",
      "Couldn't read that skill right now. Check the URL and try again.",
    );
  }
}

function extractSkillMarkdownBody(content: string): string {
  const normalized = content.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return normalized.trim();
  const afterClose = normalized.indexOf("\n", end + 1);
  return (afterClose === -1 ? "" : normalized.slice(afterClose + 1)).trim();
}
