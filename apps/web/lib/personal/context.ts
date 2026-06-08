import {
  agentBundleDir,
  type ResolvedSkillMetadata,
  resolveEnabledSkillMetadata,
  scanPersonalSkills,
} from "@opencompany/agent-runtime";
import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import { agentFiles } from "@opencompany/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { type AgentBundleFilePayload, serializeAgentBundleFiles } from "@/lib/agents/bundle-files";

// The personal agent's "context" is its agent bundle: the files materialized under
// `agents/<slug>/` (memory.md, skills, attachments). They live in the agent_files table
// scoped to (workspaceId, agentId). The agent definition file itself is excluded by
// serializeAgentBundleFiles — it's surfaced separately as the always-present AGENTS.md row.
export async function loadPersonalAgentContextFiles(
  workspaceId: string,
  agentId: string,
  agentPath: string | null,
): Promise<AgentBundleFilePayload[]> {
  if (!agentPath) return [];

  const db = getDb();
  const rows = await db
    .select()
    .from(agentFiles)
    .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.agentId, agentId)))
    .orderBy(asc(agentFiles.path));

  return serializeAgentBundleFiles(agentPath, rows);
}

// Personal skills (agent-authored playbooks under `agents/<slug>/skills/<id>/SKILL.md`) are never
// listed in `skills:` frontmatter — they're auto-discovered from the bundle at session start. To
// surface them in the capability UI we replicate the runner's discovery here: scan the same
// agent_files rows and reserve the ids already claimed by built-in/external skills so the UI shows
// exactly what would actually mount (a personal skill that collides with a reserved id is dropped).
export async function loadPersonalSkills(
  workspaceId: string,
  agentId: string,
  agentPath: string | null,
  config: Pick<AgentConfig, "skills">,
): Promise<ResolvedSkillMetadata[]> {
  if (!agentPath) return [];

  const db = getDb();
  const rows = await db
    .select({ path: agentFiles.path, content: agentFiles.content })
    .from(agentFiles)
    .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.agentId, agentId)));

  const reservedIds = resolveEnabledSkillMetadata(config).map((skill) => skill.id);
  const { skills } = scanPersonalSkills({
    bundleFiles: rows,
    bundleDir: agentBundleDir(agentPath),
    reservedIds,
  });
  return skills.map((skill) => skill.metadata);
}
