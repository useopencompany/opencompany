import { createHash } from "node:crypto";
import { type AgentSkillFile, shellQuote } from "@opencompany/agent-runtime";
import { type SandboxHandle, writeSandboxTextFiles } from "./sandbox";

const SANDBOX_ROOT_USER = "root";
const SANDBOX_USER = "user";
const CODEX_MANAGED_SKILLS_MANIFEST = ".opencompany-managed-skills.json";

export type CodexSkillSnapshot = { id: string; files: AgentSkillFile[] };

// Materialize skill snapshots into the Codex-managed `.agents/skills` tree inside the sandbox.
// A root-owned manifest records which skill directories are OpenCompany-managed so the next
// reconcile can remove stale managed skills without touching user-authored ones. The tree is
// locked read-only (dirs 555, files 444) so the sandboxed agent can read but never edit skills.
export async function materializeCodexSkillSnapshotsForSession(input: {
  sandbox: SandboxHandle;
  codexWorkRoot: string;
  skills: CodexSkillSnapshot[];
}): Promise<{ fingerprint: string; count: number }> {
  const root = `${input.codexWorkRoot}/.agents/skills`;
  const manifestPath = `${root}/${CODEX_MANAGED_SKILLS_MANIFEST}`;
  const skills = input.skills;
  for (const skill of skills) assertSafeSkillId(skill.id);
  const skillFiles = skills.flatMap((skill) =>
    skill.files.map((file) => ({
      path: `${root}/${skill.id}/${file.path}`,
      content: file.content,
    })),
  );
  const currentSkillIds = [...new Set(skills.map((skill) => skill.id))];

  await reconcileCodexManagedSkillTree({
    sandbox: input.sandbox,
    root,
    manifestPath,
    skillIds: currentSkillIds,
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
  files: Array<{ path: string; content: string }>;
}) {
  const previousSkillIds = await readCodexManagedSkillIds(input.sandbox, input.manifestPath);
  const resetSkillIds = [...new Set([...previousSkillIds, ...input.skillIds])];
  const resetCommands = [
    `chown ${SANDBOX_USER}:${SANDBOX_USER} ${shellQuote(input.root)}`,
    `chmod 755 ${shellQuote(input.root)}`,
    ...resetSkillIds.map((id) => `rm -rf ${shellQuote(`${input.root}/${id}`)}`),
  ];

  await input.sandbox.commands.run(`mkdir -p ${shellQuote(input.root)}`, { timeoutMs: 30_000 });
  await input.sandbox.commands.run(resetCommands.join(" && "), {
    user: SANDBOX_ROOT_USER,
    timeoutMs: 30_000,
  });

  await writeSandboxTextFiles({
    sandbox: input.sandbox,
    files: [
      ...input.files,
      {
        path: input.manifestPath,
        content: JSON.stringify({ version: 1, skillIds: input.skillIds }, null, 2),
      },
    ],
    user: SANDBOX_ROOT_USER,
  });

  const managedPaths = input.skillIds.map((id) => shellQuote(`${input.root}/${id}`));
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

function assertSafeSkillId(id: string) {
  if (isSafeSkillId(id)) return;
  throw new Error(`Cannot materialize Codex skill with unsafe id: ${id}`);
}

function isSafeSkillId(id: string) {
  return id.length > 0 && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\0");
}

function skillTreeFingerprint(skills: CodexSkillSnapshot[]) {
  const hash = createHash("sha256");
  for (const skill of [...skills].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update("skill\0");
    hash.update(skill.id);
    hash.update("\0");
    for (const file of [...skill.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      hash.update("file\0");
      hash.update(file.path);
      hash.update("\0");
      hash.update(file.content);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}
