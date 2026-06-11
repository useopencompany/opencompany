import { isExternalSkillReference } from "@opencompany/agent-runtime";
import type { AgentConfig, AgentExternalSkillReference } from "@opencompany/agent-runtime/types";
import type { AgentSkillCatalogEntry } from "@/components/agent-editor/tools";

export function mergeSkillCatalog(
  configSkills: AgentConfig["skills"],
  workspaceSkills: AgentSkillCatalogEntry[],
): AgentSkillCatalogEntry[] {
  const byId = new Map<string, AgentSkillCatalogEntry>();

  for (const skill of configSkills ?? []) {
    if (!isExternalSkillReference(skill)) continue;
    byId.set(skill.id, {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
    });
  }

  for (const skill of workspaceSkills) {
    const existing = byId.get(skill.id);
    const source = skill.source ?? existing?.source;
    const command = skill.command ?? existing?.command;
    byId.set(skill.id, {
      id: skill.id,
      name: skill.name || existing?.name || skill.id,
      description: skill.description || existing?.description || "",
      ...(command ? { command } : {}),
      ...(source ? { source } : {}),
    });
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillCatalogEntryToExternalReference(
  skill: AgentSkillCatalogEntry,
): AgentExternalSkillReference[] {
  if (!skill.source) return [];
  return [
    {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
    },
  ];
}
