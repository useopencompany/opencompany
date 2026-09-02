import {
  createGitHubSkillFetcher,
  resolveSkill,
  SkillResolverError,
} from "@opencompany/agent-runtime";
import { CoreError, type SkillImportResolution, type SkillImportResolver } from "@opencompany/core";

export function createSkillImportResolver(): SkillImportResolver {
  return { resolve: resolveSkillImport };
}

export async function resolveSkillImport(input: {
  url: string;
  selectedPath?: string;
}): Promise<SkillImportResolution> {
  const result = await resolveSkillOrThrow(input);
  if (result.status === "ambiguous") {
    return {
      status: "ambiguous",
      candidates: result.candidates,
      source: {
        ...result.source,
        resolvedCommit: result.resolvedCommit,
      },
    };
  }

  const skill = result.skill;
  return {
    status: "resolved",
    warnings: skill.warnings,
    bundle: {
      name: skill.name,
      description: skill.description,
      ...(skill.license !== undefined ? { license: skill.license } : {}),
      ...(skill.compatibility !== undefined ? { compatibility: skill.compatibility } : {}),
      ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
      ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
      body: skill.body,
      source: { ...skill.source, resolvedCommit: skill.resolvedCommit },
      integrity: skill.integrity,
      files: skill.files,
      fileCount: skill.fileCount,
      totalBytes: skill.totalBytes,
    },
  };
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
