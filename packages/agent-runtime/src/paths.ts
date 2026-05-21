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

  return resolved;
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
