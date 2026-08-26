import { computeArtifactIntegrity } from "./artifact-integrity";
import { parseSkillDocument, SkillSpecError } from "./skill-spec";

export type WorkspaceSkillArtifact = {
  name: string;
  description: string;
  body: string;
  source: { type: "workspace" };
  integrity: string;
  files: Array<{ path: string; content: Uint8Array; executable: boolean }>;
  fileCount: number;
  totalBytes: number;
};

/** Builds the canonical, portable SKILL.md stored for a workspace-authored Skill version. */
export async function createWorkspaceSkillArtifact(input: {
  name: string;
  description: string;
  instructions: string;
}): Promise<WorkspaceSkillArtifact> {
  const name = input.name.trim();
  const description = input.description.trim();
  const instructions = input.instructions.trim();
  if (!instructions) throw new SkillSpecError("Skill instructions must not be empty.");
  if (description.includes("\0") || instructions.includes("\0")) {
    throw new SkillSpecError("Workspace Skill text must not contain NUL characters.");
  }

  // JSON strings are valid YAML scalars and make arbitrary user-authored descriptions safe without
  // maintaining a second YAML serializer policy. The parser below remains the format authority.
  const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${instructions}\n`;
  const document = parseSkillDocument(content, name);
  const files = [
    {
      path: "SKILL.md",
      content: new TextEncoder().encode(content),
      executable: false,
    },
  ];
  return {
    name: document.frontmatter.name,
    description: document.frontmatter.description,
    body: document.body,
    source: { type: "workspace" },
    integrity: await computeArtifactIntegrity(files),
    files,
    fileCount: files.length,
    totalBytes: files[0]!.content.length,
  };
}
