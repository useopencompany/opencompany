import type { AgentSkillCatalogEntry } from "@/components/agent-editor/tools";

// Fetch the workspace's external skill catalog for the editor mention suggestions.
export async function fetchWorkspaceSkills(): Promise<AgentSkillCatalogEntry[]> {
  const response = await fetch("/api/skills");
  if (!response.ok) return [];
  const data = (await response.json()) as {
    skills?: Array<{ id?: unknown; name?: unknown; description?: unknown }>;
  };
  return (data.skills ?? []).flatMap((skill) => {
    if (typeof skill.id !== "string") return [];
    return [
      {
        id: skill.id,
        name: typeof skill.name === "string" ? skill.name : skill.id,
        description: typeof skill.description === "string" ? skill.description : "",
      },
    ];
  });
}
