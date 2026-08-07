import path from "node:path";

// Personal sessions use the memory/ + personal-brain/ + work/ tree (agent/ retained for the agent's
// private profile/soul/skill authoring, skills/ for the read-only skill mount); company sessions use
// work/ + brain/ + agent/ + skills/. `personal` selects the allowed top-level roots.
export function resolveWorkspacePath(workdir: string, inputPath = ".", personal = false) {
  if (inputPath.includes("\0")) {
    throw new Error("Path contains an invalid character.");
  }

  const relative = inputPath.trim() || ".";
  const resolved = path.posix.resolve(workdir, relative);
  const normalizedWorkdir = path.posix.resolve(workdir);

  if (resolved !== normalizedWorkdir && !resolved.startsWith(`${normalizedWorkdir}/`)) {
    throw new Error("Path must stay inside the session workspace.");
  }

  const allowedRoots = personal
    ? ["work", "memory", "personal-brain", "agent", "skills"]
    : ["work", "brain", "agent", "skills"];
  const workspaceRelative = path.posix.relative(normalizedWorkdir, resolved);
  const inAllowedRoot = allowedRoots.some(
    (root) => workspaceRelative === root || workspaceRelative.startsWith(`${root}/`),
  );
  if (!inAllowedRoot) {
    const list = allowedRoots.map((root) => `${root}/`);
    throw new Error(
      `Path must be inside ${list.slice(0, -1).join(", ")}, or ${list.at(-1)} for this session.`,
    );
  }

  return resolved;
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// File name of the memory CLI bundle delivered to the sandbox's read-only skills
// mount (`<skillsRoot>/memory/`). The runner builds the memory tool command from it.
export const MEMORY_CLI_FILE = "memory.mjs";
