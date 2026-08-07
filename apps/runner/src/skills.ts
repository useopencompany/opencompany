import { createHash } from "node:crypto";
import {
  AGENT_SKILL_DEFINITION_BY_ID,
  type AgentConfig,
  type AgentExternalSkillReference,
  type AgentSkillFile,
  type AgentWorkspaceSkillSource,
  agentBundleDir,
  isExternalSkillReference,
  isRemoteSkillReference,
  isWorkspaceSkillReference,
  MEMORY_CLI_FILE,
  MEMORY_SKILL_ID,
  resolveEnabledBuiltinSkillFiles,
  scanPersonalSkills,
  shellQuote,
} from "@opencompany/agent-runtime";
import { agentFiles, agents, workspaceSkills } from "@opencompany/db/schema";
import { getMemoryCliSource } from "@opencompany/memory/cli-bundle";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { type SandboxHandle, sandboxLayout, writeSandboxTextFiles } from "./sandbox";
import { loadExternalSkillFiles } from "./skill-snapshots";

const SANDBOX_ROOT_USER = "root";
const SANDBOX_USER = "user";
const MANAGED_SKILLS_MANIFEST = ".opencompany-managed-skills.json";
type WorkspaceSkillReference = AgentExternalSkillReference & { source: AgentWorkspaceSkillSource };
type MountedSkill = { id: string; files: AgentSkillFile[] };
export type NativeSkillSnapshot = { id: string; files: AgentSkillFile[] };

// Materialize the session's enabled skills into a read-only ./skills root. Each skill becomes
// skills/<id>/<file> (e.g. skills/agent-self-edit/SKILL.md). Files are root-owned and
// world-readable but not writable, so the agent can read them with read_skill but never edit
// them — the same isolation idea as the brain manifest, but readable.
//
// Built-in skill files ship in code; external skill files come from the workspace snapshot
// cache (refreshed to branch HEAD here in the trusted runner host). Both mount identically;
// the agent can't tell them apart beyond the provenance noted in the system prompt.
export async function materializeSkillsForSession(input: {
  sandbox: SandboxHandle;
  workdir: string;
  workspaceId: string;
  agentId: string;
  config: Pick<AgentConfig, "skills">;
}) {
  const layout = sandboxLayout(input.workdir);
  const skills = await loadOpenCompanySkillsForMount(input);
  // Personal skills (agent/skills/<id>/) mount identically to built-ins/externals, but their ids
  // must not shadow one, so reserve the ids already in play before scanning the bundle.
  const reservedIds = new Set(skills.map((skill) => skill.id));
  const personal = await loadPersonalSkillsForMount(input.workspaceId, input.agentId, reservedIds);
  skills.push(...personal);
  const memoryCliEnabled = skills.some((skill) => skill.id === MEMORY_SKILL_ID);
  const skillFiles = skills.flatMap((skill) =>
    skill.files.map((file) => ({
      path: `${layout.skillsRoot}/${skill.id}/${file.path}`,
      content: file.content,
    })),
  );
  // The `memory` skill's CLI bundle is delivered here rather than via the skill catalog so the
  // ~150 KB JS never ships inside agent-runtime (and the web bundle that imports it). The agent
  // runs it with `node skills/memory/memory.mjs <command>`.
  if (memoryCliEnabled) {
    skillFiles.push({
      path: `${layout.skillsRoot}/${MEMORY_SKILL_ID}/${MEMORY_CLI_FILE}`,
      content: getMemoryCliSource(),
    });
  }

  await resetAndWriteSkillTree({
    sandbox: input.sandbox,
    root: layout.skillsRoot,
    files: skillFiles,
  });
}

export async function materializeCodexSkillsForSession(input: {
  sandbox: SandboxHandle;
  workdir: string;
  workspaceId: string;
  config: Pick<AgentConfig, "skills">;
}): Promise<{ fingerprint: string; count: number }> {
  const layout = sandboxLayout(input.workdir);
  const root = `${layout.codexRoot}/.agents/skills`;
  const skills = await loadCodexSkillsForMount(input.workspaceId, input.config);
  return materializeManagedNativeSkillTree({ sandbox: input.sandbox, root, skills });
}

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
  for (const skill of skills) assertSafeSkillId(skill.id);
  const skillFiles = skills.flatMap((skill) =>
    skill.files.map((file) => ({
      path: `${input.root}/${skill.id}/${file.path}`,
      content: file.content,
    })),
  );
  const currentSkillIds = [...new Set(skills.map((skill) => skill.id))];

  await reconcileManagedNativeSkillTree({
    sandbox: input.sandbox,
    root: input.root,
    manifestPath,
    skillIds: currentSkillIds,
    files: skillFiles,
  });

  return {
    fingerprint: skillTreeFingerprint(skills),
    count: skills.length,
  };
}

async function reconcileManagedNativeSkillTree(input: {
  sandbox: SandboxHandle;
  root: string;
  manifestPath: string;
  skillIds: string[];
  files: Array<{ path: string; content: string }>;
}) {
  const previousSkillIds = await readManagedNativeSkillIds(input.sandbox, input.manifestPath);
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

async function readManagedNativeSkillIds(sandbox: SandboxHandle, manifestPath: string) {
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
  throw new Error(`Cannot materialize native skill with unsafe id: ${id}`);
}

function isSafeSkillId(id: string) {
  return id.length > 0 && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\0");
}

async function loadOpenCompanySkillsForMount(input: {
  workspaceId: string;
  config: Pick<AgentConfig, "skills">;
}): Promise<MountedSkill[]> {
  const builtins = resolveEnabledBuiltinSkillFiles(input.config);
  const externalRefs = (input.config.skills ?? []).filter(isRemoteSkillReference);
  const workspaceRefs = (input.config.skills ?? []).filter(isWorkspaceSkillReference);
  const externals = await loadExternalSkillFiles(input.workspaceId, externalRefs);
  const workspaceAuthored = await loadWorkspaceSkillsForMount(input.workspaceId, workspaceRefs);
  return [...builtins, ...externals, ...workspaceAuthored];
}

async function loadCodexSkillsForMount(
  workspaceId: string,
  config: Pick<AgentConfig, "skills">,
): Promise<MountedSkill[]> {
  const remoteRefs = (config.skills ?? []).filter(isRemoteSkillReference);
  const workspaceRefs = (config.skills ?? []).filter(isWorkspaceSkillReference);
  const codexCompatibleBuiltins = (config.skills ?? []).flatMap((reference) => {
    if (isExternalSkillReference(reference)) return [];
    const definition = AGENT_SKILL_DEFINITION_BY_ID.get(reference.id);
    // Default OpenCompany built-ins include tool-specific instructions (`read_skill`,
    // `update_agent_file`, memory CLI) that do not exist in native Codex sessions. Only bridge
    // explicitly selected addable built-ins, plus remote/workspace skills below.
    return definition?.addable ? [definition] : [];
  });
  const [externals, workspaceAuthored] = await Promise.all([
    loadExternalSkillFiles(workspaceId, remoteRefs),
    loadWorkspaceSkillsForMount(workspaceId, workspaceRefs),
  ]);
  return [...codexCompatibleBuiltins, ...externals, ...workspaceAuthored];
}

async function loadWorkspaceSkillsForMount(
  workspaceId: string,
  refs: WorkspaceSkillReference[],
): Promise<Array<{ id: string; files: AgentSkillFile[] }>> {
  if (refs.length === 0) return [];
  const ids = [...new Set(refs.map((ref) => ref.id))];
  const db = getDb();
  const rows = await db
    .select({
      skillId: workspaceSkills.skillId,
      content: workspaceSkills.content,
    })
    .from(workspaceSkills)
    .where(
      and(eq(workspaceSkills.workspaceId, workspaceId), inArray(workspaceSkills.skillId, ids)),
    );
  const byId = new Map(rows.map((row) => [row.skillId, row.content]));
  return refs.flatMap((ref) => {
    const content = byId.get(ref.id);
    if (!content) return [];
    return [{ id: ref.id, files: [{ path: "SKILL.md", content }] }];
  });
}

// Load the agent's personal skills from its bundle (agent_files) so they can be copied into the
// read-only skills/ mount alongside built-ins/externals. The agent authors them under
// agent/skills/<id>/ (writable, synced back); this is the active read-only snapshot for the session.
async function loadPersonalSkillsForMount(
  workspaceId: string,
  agentId: string,
  reservedIds: Set<string>,
): Promise<Array<{ id: string; files: AgentSkillFile[] }>> {
  const db = getDb();
  const [agent] = await db
    .select({ path: agents.path })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
    .limit(1);
  if (!agent?.path) return [];
  const bundleDir = agentBundleDir(agent.path);
  const rows = await db
    .select({ path: agentFiles.path, content: agentFiles.content })
    .from(agentFiles)
    .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.agentId, agentId)));
  const { skills } = scanPersonalSkills({ bundleFiles: rows, bundleDir, reservedIds });
  return skills.map((skill) => ({ id: skill.metadata.id, files: skill.files }));
}

async function resetAndWriteSkillTree(input: {
  sandbox: SandboxHandle;
  root: string;
  files: Array<{ path: string; content: string }>;
}) {
  await input.sandbox.commands.run(
    `rm -rf ${shellQuote(input.root)} && mkdir -p ${shellQuote(input.root)}`,
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );

  await writeSandboxTextFiles({
    sandbox: input.sandbox,
    files: input.files,
    user: SANDBOX_ROOT_USER,
  });

  // Lock the tree down: root-owned, directories traversable+readable (555), files read-only
  // (444). The agent runs as `user` and can read via the world bits but cannot write.
  await input.sandbox.commands.run(
    [
      `chown -R ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(input.root)}`,
      `find ${shellQuote(input.root)} -type d -exec chmod 555 {} +`,
      `find ${shellQuote(input.root)} -type f -exec chmod 444 {} +`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
}

function skillTreeFingerprint(skills: MountedSkill[]) {
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
