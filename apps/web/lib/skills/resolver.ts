import {
  createGitHubSkillFetcher,
  type ResolveSkillResult,
  resolveSkill,
} from "@opencompany/agent-runtime";
import { findSnapshotForSource, listWorkspaceSkillSnapshots } from "@/lib/skills/snapshots";

// Resolve a skill for a workspace: dedup mount ids against the existing catalog, and reuse the
// mount id of an already-stored snapshot for the same source so re-adds stay stable.
export async function resolveWorkspaceSkill(input: {
  url: string;
  workspaceId: string;
  selectedPath?: string;
}): Promise<ResolveSkillResult> {
  const snapshots = await listWorkspaceSkillSnapshots(input.workspaceId);
  const reservedIds = new Set(snapshots.map((snapshot) => snapshot.skillId));
  const result = await resolveSkill({
    url: input.url,
    fetcher: createGitHubSkillFetcher(),
    reservedIds,
    ...(input.selectedPath !== undefined ? { selectedPath: input.selectedPath } : {}),
  });
  if (result.status === "resolved") {
    const existing = findSnapshotForSource(snapshots, result.skill.source);
    if (existing) result.skill.skillId = existing.skillId;
  }
  return result;
}
