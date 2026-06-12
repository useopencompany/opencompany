import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBridgePath } from "./permissions";
import {
  BRIDGE_LIST_ENTRIES_CAP,
  BRIDGE_READ_FILE_CAP,
  BRIDGE_SHELL_OUTPUT_CAP,
  BRIDGE_SHELL_TIMEOUT_MS,
  type BridgeListFilesArgs,
  type BridgeListFilesOutput,
  type BridgeReadFileArgs,
  type BridgeReadFileOutput,
  type BridgeShellArgs,
  type BridgeShellOutput,
  type BridgeWriteFileArgs,
  type BridgeWriteFileOutput,
} from "./protocol";

// Executes the four bridge tools on the local machine. Every path goes through
// resolveBridgePath so execution targets exactly what the permission engine
// evaluated — the two must never diverge.

export type BridgeExecutor = {
  local_shell(args: BridgeShellArgs): Promise<BridgeShellOutput>;
  local_read_file(args: BridgeReadFileArgs): Promise<BridgeReadFileOutput>;
  local_write_file(args: BridgeWriteFileArgs): Promise<BridgeWriteFileOutput>;
  local_list_files(args: BridgeListFilesArgs): Promise<BridgeListFilesOutput>;
};

// shellTimeoutMs is overridable only so tests don't have to wait out the real
// two-minute cap.
export function createExecutor(opts: { shellTimeoutMs?: number } = {}): BridgeExecutor {
  const shellTimeoutMs = opts.shellTimeoutMs ?? BRIDGE_SHELL_TIMEOUT_MS;
  return {
    local_shell: (args) => runShell(args, shellTimeoutMs),
    local_read_file: readFile,
    local_write_file: writeFile,
    local_list_files: listFiles,
  };
}

function runShell(args: BridgeShellArgs, timeoutMs: number): Promise<BridgeShellOutput> {
  return new Promise((resolveShell, rejectShell) => {
    const cwd = resolveBridgePath(args.cwd ?? homedir());
    // detached puts the command in its own process group so the timeout can kill
    // the whole tree — killing only `sh` would leave its children running and
    // holding the stdio pipes open.
    const child = spawn("sh", ["-c", args.command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const killTimer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    let truncated = false;
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= BRIDGE_SHELL_OUTPUT_CAP) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > BRIDGE_SHELL_OUTPUT_CAP) {
        truncated = true;
        return next.slice(0, BRIDGE_SHELL_OUTPUT_CAP);
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(killTimer);
      rejectShell(error);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      // code is null when the timeout killed the process via signal.
      resolveShell({
        stdout,
        stderr,
        exitCode: code ?? -1,
        ...(truncated ? { truncated: true } : {}),
      });
    });
  });
}

async function readFile(args: BridgeReadFileArgs): Promise<BridgeReadFileOutput> {
  const path = resolveBridgePath(args.path);
  const content = await fs.readFile(path, "utf8");
  if (content.length > BRIDGE_READ_FILE_CAP) {
    return { content: content.slice(0, BRIDGE_READ_FILE_CAP), truncated: true };
  }
  return { content };
}

async function writeFile(args: BridgeWriteFileArgs): Promise<BridgeWriteFileOutput> {
  const path = resolveBridgePath(args.path);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, args.content, "utf8");
  return { path, bytesWritten: Buffer.byteLength(args.content, "utf8") };
}

const SKIPPED_WALK_DIRS = new Set([".git", "node_modules"]);

async function listFiles(args: BridgeListFilesArgs): Promise<BridgeListFilesOutput> {
  const root = resolveBridgePath(args.path);
  const entries: BridgeListFilesOutput["entries"] = [];
  let truncated = false;

  const visit = async (dir: string, prefix: string): Promise<void> => {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (entries.length >= BRIDGE_LIST_ENTRIES_CAP) {
        truncated = true;
        return;
      }
      const name = prefix.length > 0 ? `${prefix}/${dirent.name}` : dirent.name;
      const type = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "dir" : "file";
      if (type === "file") {
        const stats = await fs.stat(join(dir, dirent.name));
        entries.push({ name, type, size: stats.size });
      } else {
        entries.push({ name, type });
      }
      if (args.recursive === true && type === "dir" && !SKIPPED_WALK_DIRS.has(dirent.name)) {
        await visit(join(dir, dirent.name), name);
      }
    }
  };

  await visit(root, "");
  return { entries, ...(truncated ? { truncated: true } : {}) };
}
