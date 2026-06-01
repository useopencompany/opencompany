import path from "node:path";

export function resolveWorkspacePath(workdir: string, inputPath = ".") {
  if (inputPath.includes("\0")) {
    throw new Error("Path contains an invalid character.");
  }

  const relative = inputPath.trim() || ".";
  const resolved = path.posix.resolve(workdir, relative);
  const normalizedWorkdir = path.posix.resolve(workdir);

  if (resolved !== normalizedWorkdir && !resolved.startsWith(`${normalizedWorkdir}/`)) {
    throw new Error("Path must stay inside the session workspace.");
  }

  const workspaceRelative = path.posix.relative(normalizedWorkdir, resolved);
  if (
    workspaceRelative !== "work" &&
    !workspaceRelative.startsWith("work/") &&
    workspaceRelative !== "brain" &&
    !workspaceRelative.startsWith("brain/") &&
    workspaceRelative !== "agent" &&
    !workspaceRelative.startsWith("agent/") &&
    workspaceRelative !== "skills" &&
    !workspaceRelative.startsWith("skills/")
  ) {
    throw new Error("Path must be inside work/, brain/, or agent/ for this session.");
  }

  return resolved;
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
