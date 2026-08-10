import {
  createGitHubSkillFetcher,
  resolveSkill,
  SkillResolverError,
  slugifySkillName,
} from "@opencompany/agent-runtime";
import type { GoatSkillSourceType } from "@opencompany/db/goat-schema";

// Goat-specific wrapper around the shared skill resolver (packages/agent-runtime/src/skill-
// resolver.ts, the same one `apps/web`'s external skills use). Goat skills are instructions-only
// in V1 (see docs/future-concepts/goat-plugins-alignment-proposal.md) — a resolved skill's
// SKILL.md body becomes `instructions`; any other bundled files (scripts/, references/) are
// reported but not imported. Goat also has its own slug scheme (`uniqueGoatSkillSlug` in
// apps/goat/lib/skills.ts, workspace-scoped), so the resolver's own `ensureSkillMountId` /
// `reservedIds` (tied to apps/web's built-in skill namespace) are intentionally unused here —
// this only proposes a slug; the create step is what makes it unique.

export class GoatSkillImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoatSkillImportError";
  }
}

export type GoatSkillImportSource = {
  type: GoatSkillSourceType;
  url: string;
  ref: string;
  path: string;
};

export type GoatSkillImportCandidate = {
  path: string;
  name: string;
  description: string;
};

export type GoatSkillImportPreview =
  | {
      status: "resolved";
      proposedSlug: string;
      name: string;
      description: string;
      instructions: string;
      source: GoatSkillImportSource;
      resolvedCommit: string;
      integrity: string;
      // Paths of files beyond SKILL.md (e.g. scripts/, references/) that were found but won't
      // be imported — Goat skills are instructions-only in V1.
      extraFiles: string[];
    }
  | {
      status: "ambiguous";
      candidates: GoatSkillImportCandidate[];
      source: Pick<GoatSkillImportSource, "type" | "url" | "ref">;
    };

export async function previewGoatSkillImport(input: {
  url: string;
  selectedPath?: string;
}): Promise<GoatSkillImportPreview> {
  const result = await resolveSkillOrThrow(input);
  if (result.status === "ambiguous") {
    return {
      status: "ambiguous",
      candidates: result.candidates.map((candidate) => ({
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
    // The resolver already guarantees a SKILL.md exists (validateSkillFiles); this is a
    // defensive guard, not an expected path.
    throw new GoatSkillImportError("Resolved skill is missing its SKILL.md content.");
  }

  return {
    status: "resolved",
    proposedSlug: slugifySkillName(skill.name) || "skill",
    name: skill.name,
    description: skill.description,
    instructions: extractSkillMarkdownBody(skillMarkdown.content),
    source: skill.source,
    resolvedCommit: skill.resolvedCommit,
    integrity: skill.integrity,
    extraFiles: skill.files.filter((file) => file.path !== "SKILL.md").map((file) => file.path),
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
    if (error instanceof SkillResolverError) throw new GoatSkillImportError(error.message);
    throw error;
  }
}

// SKILL.md content minus its YAML frontmatter block, mirroring the frontmatter-block detection
// in parseSkillFrontmatter (packages/agent-runtime/src/skill-resolver.ts) so the two stay in
// sync: the same "---\n ... \n---" boundaries decide both what's frontmatter and what's body.
function extractSkillMarkdownBody(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return normalized.trim();
  const afterClose = normalized.indexOf("\n", end + 1);
  return (afterClose === -1 ? "" : normalized.slice(afterClose + 1)).trim();
}
