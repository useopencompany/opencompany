import type { AgentSkillCatalogEntry } from "@/components/agent-editor/tools";

// Fetch the workspace's external skill catalog for the editor mention suggestions.
export async function fetchWorkspaceSkills(): Promise<AgentSkillCatalogEntry[]> {
  const response = await fetch("/api/skills");
  if (!response.ok) return [];
  const data = (await response.json()) as {
    skills?: Array<{ id?: unknown; name?: unknown; description?: unknown; source?: unknown }>;
  };
  return (data.skills ?? []).flatMap((skill) => {
    if (typeof skill.id !== "string") return [];
    const source = parseSkillSource(skill.source);
    return [
      {
        id: skill.id,
        name: typeof skill.name === "string" ? skill.name : skill.id,
        description: typeof skill.description === "string" ? skill.description : "",
        ...(source ? { source } : {}),
      },
    ];
  });
}

function parseSkillSource(value: unknown): AgentSkillCatalogEntry["source"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const type = source.type;
  if (type !== "github" && type !== "skills.sh") return null;
  if (
    typeof source.url !== "string" ||
    typeof source.ref !== "string" ||
    typeof source.path !== "string"
  ) {
    return null;
  }
  return {
    type,
    url: source.url,
    ref: source.ref,
    path: source.path,
  };
}
