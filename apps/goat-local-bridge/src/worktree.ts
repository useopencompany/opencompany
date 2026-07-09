import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type WorktreePlan = {
  repoPath: string;
  worktreePath: string;
  gitArgs: string[];
};

export type SessionWorkspacePlan = {
  workspacePath: string;
};

export function validateLocalRepoPath(input: { repoPath: string; homeDir?: string }) {
  const homeDir = path.resolve(input.homeDir ?? homedir());
  const repoPath = path.resolve(input.repoPath);
  if (!path.isAbsolute(input.repoPath)) {
    return { ok: false as const, error: "Repository path must be absolute." };
  }
  if (!isPathInside(repoPath, homeDir)) {
    return { ok: false as const, error: "Repository path must be under $HOME." };
  }
  return { ok: true as const, repoPath };
}

export function buildWorktreePlan(input: {
  repoPath: string;
  sessionId: string;
  homeDir?: string;
}): WorktreePlan {
  const homeDir = path.resolve(input.homeDir ?? homedir());
  const repoPath = path.resolve(input.repoPath);
  const safeSessionId = safePathSegment(input.sessionId);
  const worktreePath = path.join(homeDir, ".opencompany", "goat", "worktrees", safeSessionId);
  return {
    repoPath,
    worktreePath,
    gitArgs: ["-C", repoPath, "worktree", "add", "--detach", worktreePath, "HEAD"],
  };
}

export function buildSessionWorkspacePlan(input: {
  sessionId: string;
  homeDir?: string;
}): SessionWorkspacePlan {
  const homeDir = path.resolve(input.homeDir ?? homedir());
  const safeSessionId = safePathSegment(input.sessionId);
  return {
    workspacePath: path.join(homeDir, ".opencompany", "goat", "sessions", safeSessionId),
  };
}

export async function resolveGitRepoRoot(repoPath: string) {
  const root = await runBuffered("git", ["-C", repoPath, "rev-parse", "--show-toplevel"]);
  return root.trim();
}

export async function ensureDetachedHeadWorktree(input: {
  repoPath: string;
  sessionId: string;
  homeDir?: string;
}) {
  const validation = validateLocalRepoPath({
    repoPath: input.repoPath,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  });
  if (!validation.ok) throw new Error(validation.error);

  const repoRoot = await resolveGitRepoRoot(validation.repoPath);
  const rootValidation = validateLocalRepoPath({
    repoPath: repoRoot,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  });
  if (!rootValidation.ok) throw new Error(rootValidation.error);

  const plan = buildWorktreePlan({
    repoPath: rootValidation.repoPath,
    sessionId: input.sessionId,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  });
  await mkdir(path.dirname(plan.worktreePath), { recursive: true });
  await runBuffered("git", plan.gitArgs, { allowExistingWorktree: true });
  return plan;
}

export async function ensureEmptySessionWorkspace(input: { sessionId: string; homeDir?: string }) {
  const plan = buildSessionWorkspacePlan(input);
  await mkdir(plan.workspacePath, { recursive: true });
  return plan;
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isPathInside(child: string, parent: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function runBuffered(
  command: string,
  args: string[],
  options: { allowExistingWorktree?: boolean } = {},
) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    const message = stderr || stdout || `${command} exited with code ${code ?? "unknown"}.`;
    if (
      options.allowExistingWorktree &&
      /already exists|is a missing but already registered worktree/i.test(message)
    ) {
      return stdout;
    }
    throw new Error(message.trim());
  }
  return stdout;
}
