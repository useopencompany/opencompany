"use server";

import { type AgentExternalSkillReference, SkillResolverError } from "@opencompany/agent-runtime";
import { currentWorkspace } from "@/lib/auth";
import { resolveWorkspaceSkill } from "@/lib/skills/resolver";
import { saveSkillSnapshot, toExternalSkillReference } from "@/lib/skills/snapshots";

type SkillCandidate = { path: string; name: string; description: string };

export type SaveSkillResult =
  | { status: "saved"; skill: AgentExternalSkillReference }
  | { status: "ambiguous"; candidates: SkillCandidate[] }
  | { status: "error"; message: string };

// Resolve a skill source and persist it into the current workspace's catalog. This is the
// mutation path for "Add skill"; App Router mutations run as Server Actions (never API routes).
// Returns the external reference the editor inserts as @skill/<id>, an ambiguous candidate list
// to choose from, or a user-facing error message.
export async function saveSkill(input: {
  url: string;
  selectedPath?: string;
}): Promise<SaveSkillResult> {
  const { workspace } = await currentWorkspace();

  if (typeof input.url !== "string" || !input.url.trim()) {
    return { status: "error", message: "A skill URL is required." };
  }

  try {
    const result = await resolveWorkspaceSkill({
      url: input.url,
      workspaceId: workspace.id,
      ...(typeof input.selectedPath === "string" ? { selectedPath: input.selectedPath } : {}),
    });
    if (result.status === "ambiguous") {
      return { status: "ambiguous", candidates: result.candidates };
    }
    const snapshot = await saveSkillSnapshot(workspace.id, result.skill);
    return { status: "saved", skill: toExternalSkillReference(snapshot) };
  } catch (error) {
    if (error instanceof SkillResolverError) {
      return { status: "error", message: error.message };
    }
    return { status: "error", message: "Couldn't add that skill. Check the URL and try again." };
  }
}
