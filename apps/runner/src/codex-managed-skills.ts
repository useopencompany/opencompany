import path from "node:path";
import { type AgentSkillFile, assertSafeRelativePath } from "@opencompany/agent-runtime";
import { managedArtifactFingerprint, reconcileManagedArtifactTree } from "./managed-artifact-tree";
import type { SandboxHandle } from "./sandbox";

const MANAGED_SKILLS_MANIFEST = ".opencompany-managed-skills.json";

export type NativeSkillSnapshot = { name: string; files: AgentSkillFile[] };

export async function materializeCodexSkillSnapshotsForSession(input: {
  sandbox: SandboxHandle;
  codexWorkRoot: string;
  skills: NativeSkillSnapshot[];
}): Promise<{ fingerprint: string; count: number }> {
  return materializeManagedNativeSkillTree({
    sandbox: input.sandbox,
    root: `${input.codexWorkRoot}/.agents/skills`,
    skills: input.skills,
  });
}

export async function materializeClaudeSkillSnapshotsForSession(input: {
  sandbox: SandboxHandle;
  claudeWorkRoot: string;
  skills: NativeSkillSnapshot[];
}): Promise<{ fingerprint: string; count: number }> {
  return materializeManagedNativeSkillTree({
    sandbox: input.sandbox,
    root: `${input.claudeWorkRoot}/.claude/skills`,
    skills: input.skills,
  });
}

async function materializeManagedNativeSkillTree(input: {
  sandbox: SandboxHandle;
  root: string;
  skills: NativeSkillSnapshot[];
}) {
  const skillNames = new Set<string>();
  const files = input.skills.flatMap((skill) => {
    assertSafeSkillName(skill.name);
    if (skillNames.has(skill.name)) {
      throw new Error(`Cannot materialize duplicate Skill name: ${skill.name}`);
    }
    skillNames.add(skill.name);
    const filePaths = new Set<string>();
    return skill.files.map((file) => {
      if (filePaths.has(file.path)) {
        throw new Error(`Cannot materialize duplicate Skill file path: ${file.path}`);
      }
      filePaths.add(file.path);
      return {
        path: containedSkillFilePath(input.root, skill.name, file.path),
        content: file.content,
        executable: file.executable,
      };
    });
  });
  const ids = [...skillNames];
  await reconcileManagedArtifactTree({
    sandbox: input.sandbox,
    root: input.root,
    manifestName: MANAGED_SKILLS_MANIFEST,
    manifestKey: "skillIds",
    ids,
    files,
    isSafeId: isSafeSkillId,
  });
  return {
    fingerprint: managedArtifactFingerprint(
      input.skills.map((skill) => ({
        kind: "skill",
        id: skill.name,
        files: skill.files,
      })),
    ),
    count: input.skills.length,
  };
}

function assertSafeSkillName(name: string) {
  try {
    assertSafeRelativePath(name);
  } catch {
    throw new Error(`Cannot materialize Skill with unsafe name: ${name}`);
  }
  if (name.includes("/")) throw new Error(`Cannot materialize Skill with unsafe name: ${name}`);
}

function isSafeSkillId(id: string) {
  try {
    assertSafeSkillName(id);
    return true;
  } catch {
    return false;
  }
}

function containedSkillFilePath(root: string, skillName: string, relativePath: string) {
  try {
    assertSafeRelativePath(relativePath);
  } catch (error) {
    throw new Error(
      `Cannot materialize Skill file with unsafe path ${JSON.stringify(relativePath)}: ${error instanceof Error ? error.message : "invalid path"}`,
    );
  }
  const skillRoot = path.posix.resolve(root, skillName);
  const targetPath = path.posix.resolve(skillRoot, relativePath);
  if (!targetPath.startsWith(`${skillRoot}/`)) {
    throw new Error(`Cannot materialize Skill file outside its root: ${relativePath}`);
  }
  return targetPath;
}
