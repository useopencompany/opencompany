import {
  type AgentConfig,
  type AgentSkillFile,
  isExternalSkillReference,
  MEMORY_CLI_FILE,
  MEMORY_SKILL_ID,
  resolveEnabledBuiltinSkillFiles,
  shellQuote,
} from "@opencompany/agent-runtime";
import { getMemoryCliSource } from "@opencompany/memory/cli-bundle";
import { type SandboxHandle, sandboxLayout } from "./sandbox";
import { loadExternalSkillFiles } from "./skill-snapshots";

const SANDBOX_ROOT_USER = "root";

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
  config: Pick<AgentConfig, "skills">;
}) {
  const layout = sandboxLayout(input.workdir);
  const builtins = resolveEnabledBuiltinSkillFiles(input.config);
  const externalRefs = (input.config.skills ?? []).filter(isExternalSkillReference);
  const externals = await loadExternalSkillFiles(input.workspaceId, externalRefs);
  const skills: Array<{ id: string; files: AgentSkillFile[] }> = [...builtins, ...externals];

  await input.sandbox.commands.run(
    `rm -rf ${shellQuote(layout.skillsRoot)} && mkdir -p ${shellQuote(layout.skillsRoot)}`,
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );

  for (const skill of skills) {
    for (const file of skill.files) {
      const fullPath = `${layout.skillsRoot}/${skill.id}/${file.path}`;
      await input.sandbox.commands.run(`mkdir -p ${shellQuote(dirname(fullPath))}`, {
        user: SANDBOX_ROOT_USER,
        timeoutMs: 30_000,
      });
      await input.sandbox.files.write(fullPath, file.content, { user: SANDBOX_ROOT_USER });
    }
  }

  // The `memory` skill's CLI bundle is delivered here rather than via the skill catalog so the
  // ~150 KB JS never ships inside agent-runtime (and the web bundle that imports it). The agent
  // runs it with `bun skills/memory/memory.js <command>`.
  if (skills.some((skill) => skill.id === MEMORY_SKILL_ID)) {
    await input.sandbox.files.write(
      `${layout.skillsRoot}/${MEMORY_SKILL_ID}/${MEMORY_CLI_FILE}`,
      getMemoryCliSource(),
      { user: SANDBOX_ROOT_USER },
    );
  }

  // Lock the tree down: root-owned, directories traversable+readable (555), files read-only
  // (444). The agent runs as `user` and can read via the world bits but cannot write.
  await input.sandbox.commands.run(
    [
      `chown -R ${SANDBOX_ROOT_USER}:${SANDBOX_ROOT_USER} ${shellQuote(layout.skillsRoot)}`,
      `find ${shellQuote(layout.skillsRoot)} -type d -exec chmod 555 {} +`,
      `find ${shellQuote(layout.skillsRoot)} -type f -exec chmod 444 {} +`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}
