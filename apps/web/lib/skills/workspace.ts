import { createHash } from "node:crypto";
import {
  type AgentExternalSkillReference,
  extractMentionIds,
  isKnownAgentSkillId,
  isValidSkillMountId,
  serializeSkillMarkdown,
  slugifySkillName,
  validateSkillFiles,
  workspaceSkillSourcePath,
} from "@opencompany/agent-runtime";
import type { AgentConfig } from "@opencompany/agent-runtime/types";
import type { workspaceSkills } from "@opencompany/db/schema";

export type WorkspaceSkillRow = typeof workspaceSkills.$inferSelect;

export type WorkspaceSkillPayload = {
  id: number;
  skillId: string;
  name: string;
  description: string;
  body: string;
  path: string;
  sizeBytes: number;
  githubSyncStatus: string;
  githubSyncError: string | null;
  githubCommitSha: string | null;
  githubSyncedAt: string | null;
  updatedAt: string;
};

export type SerializedWorkspaceSkill =
  | {
      ok: true;
      name: string;
      description: string;
      body: string;
      content: string;
      contentHash: string;
      sizeBytes: number;
    }
  | { ok: false; error: string };

export function workspaceSkillRepoPath(skillId: string): string {
  return `${workspaceSkillSourcePath(skillId)}/SKILL.md`;
}

export function workspaceSkillContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function workspaceSkillContentSize(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

export function serializeWorkspaceSkill(input: {
  name: string;
  description: string;
  body: string;
}): SerializedWorkspaceSkill {
  const name = input.name.trim();
  const description = input.description.trim();
  const body = input.body.replace(/\r\n/g, "\n").replace(/\s+$/g, "");

  if (!name) return { ok: false, error: "Skill name is required." };
  if (!description) return { ok: false, error: "Skill description is required." };

  const content = serializeSkillMarkdown({ name, description, body });
  const validationError = validateSkillFiles([{ path: "SKILL.md", content }]);
  if (validationError) return { ok: false, error: validationError };

  return {
    ok: true,
    name,
    description,
    body,
    content,
    contentHash: workspaceSkillContentHash(content),
    sizeBytes: workspaceSkillContentSize(content),
  };
}

export function workspaceSkillPayload(row: WorkspaceSkillRow): WorkspaceSkillPayload {
  return {
    id: row.id,
    skillId: row.skillId,
    name: row.name,
    description: row.description,
    body: row.body,
    path: workspaceSkillRepoPath(row.skillId),
    sizeBytes: row.sizeBytes,
    githubSyncStatus: row.githubSyncStatus,
    githubSyncError: row.githubSyncError,
    githubCommitSha: row.githubCommitSha,
    githubSyncedAt: row.githubSyncedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toWorkspaceSkillReference(
  skill: Pick<WorkspaceSkillRow, "skillId" | "name" | "description">,
): AgentExternalSkillReference {
  return {
    id: skill.skillId,
    name: skill.name,
    description: skill.description,
    source: {
      type: "workspace",
      path: workspaceSkillSourcePath(skill.skillId),
    },
  };
}

export function agentReferencesWorkspaceSkill(input: {
  body: string;
  config: Pick<AgentConfig, "skills">;
  skillId: string;
}): boolean {
  const mentionId = `skill/${input.skillId}`.toLowerCase();
  if (extractMentionIds(input.body).some((id) => id.toLowerCase() === mentionId)) return true;
  return (input.config.skills ?? []).some((skill) => skill.id === input.skillId);
}

export function baseWorkspaceSkillId(name: string): string {
  const slug = slugifySkillName(name);
  return isValidSkillMountId(slug) ? slug : "skill";
}

export function nextWorkspaceSkillId(base: string, reserved: Set<string>): string {
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const root = base.slice(0, 63 - suffix.length).replace(/-+$/g, "") || "skill";
    const candidate = `${root}${suffix}`;
    if (
      isValidSkillMountId(candidate) &&
      !isKnownAgentSkillId(candidate) &&
      !reserved.has(candidate)
    ) {
      return candidate;
    }
  }
  throw new Error("Could not allocate a unique skill id.");
}
