import { createHash } from "node:crypto";
import path from "node:path";
import {
  type AgentSkillFile,
  assertSafeRelativePath,
  shellQuote,
} from "@opencompany/agent-runtime";
import { type SandboxHandle, writeSandboxTextFiles } from "./sandbox";

const SANDBOX_ROOT_USER = "root";
const MANAGED_SKILLS_MANIFEST = ".opencompany-managed-skills.json";

export type NativeSkillSnapshot = { name: string; files: AgentSkillFile[] };

// Materialize skill snapshots into the Codex-managed `.agents/skills` tree inside the sandbox.
// A root-owned manifest records which skill directories are opencompany-managed so the next
// reconcile can remove stale managed skills without touching user-authored ones. The tree is
// locked read-only (dirs 555, executable files 555, other files 444) so the sandboxed agent can
// read and execute bundle files but never edit them.
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
  const manifestPath = `${input.root}/${MANAGED_SKILLS_MANIFEST}`;
  const skills = input.skills;
  const skillNames = new Set<string>();
  const skillFiles = skills.flatMap((skill) => {
    assertSafeSkillName(skill.name);
    if (skillNames.has(skill.name)) {
      throw new Error(`Cannot materialize duplicate Skill name: ${skill.name}`);
    }
    skillNames.add(skill.name);
    const filePaths = new Set<string>();
    return skill.files.map((file) => {
      const targetPath = containedSkillFilePath(input.root, skill.name, file.path);
      if (filePaths.has(file.path)) {
        throw new Error(`Cannot materialize duplicate Skill file path: ${file.path}`);
      }
      filePaths.add(file.path);
      return {
        path: targetPath,
        content: file.content,
        executable: file.executable,
      };
    });
  });
  const currentSkillNames = [...skillNames];

  await reconcileCodexManagedSkillTree({
    sandbox: input.sandbox,
    root: input.root,
    manifestPath,
    skillIds: currentSkillNames,
    files: skillFiles,
  });

  return {
    fingerprint: skillTreeFingerprint(skills),
    count: skills.length,
  };
}

async function reconcileCodexManagedSkillTree(input: {
  sandbox: SandboxHandle;
  root: string;
  manifestPath: string;
  skillIds: string[];
  files: Array<{ path: string; content: Uint8Array; executable: boolean }>;
}) {
  const previousSkillIds = await readCodexManagedSkillIds(input.sandbox, input.manifestPath);
  const resetSkillIds = [...new Set([...previousSkillIds, ...input.skillIds])];
  const resetCommands = [
    `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(input.root)}`,
    `chmod 755 ${shellQuote(input.root)}`,
    ...resetSkillIds.map((id) => `rm -rf ${shellQuote(`${input.root}/${id}`)}`),
  ];

  await input.sandbox.commands.run(`mkdir -p ${shellQuote(input.root)}`, {
    user: SANDBOX_ROOT_USER,
    timeoutMs: 30_000,
  });
  await input.sandbox.commands.run(resetCommands.join(" && "), {
    user: SANDBOX_ROOT_USER,
    timeoutMs: 30_000,
  });

  await writeSandboxTextFiles({
    sandbox: input.sandbox,
    files: [
      ...input.files.map(({ path: filePath, content }) => ({ path: filePath, content })),
      {
        path: input.manifestPath,
        content: JSON.stringify({ version: 1, skillIds: input.skillIds }, null, 2),
      },
    ],
    user: SANDBOX_ROOT_USER,
  });

  const managedPaths = input.skillIds.map((id) => shellQuote(`${input.root}/${id}`));
  const executablePaths = input.files
    .filter((file) => file.executable)
    .map((file) => shellQuote(file.path));
  const lockCommands = [
    `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(input.manifestPath)}`,
    `chmod 444 ${shellQuote(input.manifestPath)}`,
    ...(managedPaths.length > 0
      ? [
          `chown -R ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${managedPaths.join(" ")}`,
          `find ${managedPaths.join(" ")} -type d -exec chmod 555 {} +`,
          `find ${managedPaths.join(" ")} -type f -exec chmod 444 {} +`,
        ]
      : []),
  ];
  await input.sandbox.commands.run(lockCommands.join(" && "), {
    user: SANDBOX_ROOT_USER,
    timeoutMs: 30_000,
  });
  for (const executableChunk of chunkShellArguments(executablePaths)) {
    await input.sandbox.commands.run(`chmod 555 ${executableChunk.join(" ")}`, {
      user: SANDBOX_ROOT_USER,
      timeoutMs: 30_000,
    });
  }
  await input.sandbox.commands.run(
    [
      `chown ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(input.root)}`,
      `chmod 555 ${shellQuote(input.root)}`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
}

async function readCodexManagedSkillIds(sandbox: SandboxHandle, manifestPath: string) {
  let content: string;
  try {
    content = String(await sandbox.files.read(manifestPath));
  } catch {
    return [];
  }

  try {
    const parsed = JSON.parse(content) as { version?: unknown; skillIds?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.skillIds)) return [];
    return parsed.skillIds.filter((id): id is string => {
      if (typeof id !== "string") return false;
      return isSafeSkillId(id);
    });
  } catch {
    return [];
  }
}

function assertSafeSkillName(name: string) {
  try {
    assertSafeRelativePath(name);
  } catch {
    throw new Error(`Cannot materialize Skill with unsafe name: ${name}`);
  }
  if (!name.includes("/")) return;
  throw new Error(`Cannot materialize Skill with unsafe name: ${name}`);
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

function skillTreeFingerprint(skills: NativeSkillSnapshot[]) {
  const hash = createHash("sha256");
  for (const skill of [...skills].sort((left, right) => left.name.localeCompare(right.name))) {
    hashField(hash, Buffer.from("skill", "utf8"));
    hashField(hash, Buffer.from(skill.name, "utf8"));
    for (const file of [...skill.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      hashField(hash, Buffer.from("file", "utf8"));
      hashField(hash, Buffer.from(file.path, "utf8"));
      hashField(hash, Uint8Array.of(file.executable ? 1 : 0));
      hashField(hash, file.content);
    }
  }
  return hash.digest("hex");
}

function hashField(hash: ReturnType<typeof createHash>, bytes: Uint8Array) {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function chunkShellArguments(args: string[], maxCharacters = 24_000) {
  const chunks: string[][] = [];
  let current: string[] = [];
  let characters = 0;
  for (const argument of args) {
    if (current.length > 0 && characters + argument.length + 1 > maxCharacters) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(argument);
    characters += argument.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
