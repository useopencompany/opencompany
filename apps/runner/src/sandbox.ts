import path from "node:path";
import { resolveWorkspacePath, shellQuote } from "@opencompany/agent-runtime";
import { Sandbox } from "e2b";

export type SandboxHandle = Awaited<ReturnType<typeof Sandbox.create>>;

const ACTIVE_SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;
const SANDBOX_REQUEST_TIMEOUT_MS = 30_000;
const SANDBOX_USER = "user";
const SANDBOX_ROOT_USER = "root";
const METADATA_ROOT = "/home/user/.opencompany";

export function sandboxLayout(workdir: string) {
  return {
    workspaceRoot: workdir,
    brainRoot: `${workdir}/brain`,
    workRoot: `${workdir}/work`,
    metadataRoot: METADATA_ROOT,
    agentFile: `${METADATA_ROOT}/agent.agent`,
    brainManifest: `${METADATA_ROOT}/brain-manifest.json`,
  };
}

export async function createOrConnectSandbox(input: {
  sandboxId?: string | null;
  template?: string | undefined;
  envs: Record<string, string>;
  idleTimeoutMs: number;
}) {
  if (input.sandboxId) {
    try {
      return await Sandbox.connect(input.sandboxId, {
        timeoutMs: ACTIVE_SANDBOX_TIMEOUT_MS,
        requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      if (!isSandboxNotFound(error)) {
        throw error;
      }
    }
  }

  return createSandbox(input);
}

async function createSandbox(input: {
  template?: string | undefined;
  envs: Record<string, string>;
  idleTimeoutMs: number;
}) {
  const options = {
    envs: input.envs,
    timeoutMs: input.idleTimeoutMs,
    lifecycle: {
      onTimeout: "pause" as const,
      autoResume: true,
    },
  };

  const sandbox = input.template
    ? await Sandbox.create(input.template, options)
    : await Sandbox.create(options);
  await sandbox.setTimeout(ACTIVE_SANDBOX_TIMEOUT_MS, {
    requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
  });
  return sandbox;
}

export async function armSandboxIdleTimeout(sandbox: SandboxHandle, idleTimeoutMs: number) {
  try {
    const info = await sandbox.getInfo({ requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS });
    if (info.lifecycle?.onTimeout !== "pause") {
      await sandbox.pause({ requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS });
      return true;
    }

    await sandbox.setTimeout(idleTimeoutMs, { requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS });
    return true;
  } catch (error) {
    if (isSandboxNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function killSandbox(sandboxId: string) {
  try {
    return await Sandbox.kill(sandboxId, { requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS });
  } catch (error) {
    if (isSandboxNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function prepareWorkspace(input: {
  sandbox: SandboxHandle;
  workdir: string;
  agentFile: string;
}) {
  const layout = sandboxLayout(input.workdir);

  await input.sandbox.commands.run(
    [
      `mkdir -p ${shellQuote(layout.brainRoot)} ${shellQuote(layout.workRoot)} ${shellQuote(layout.metadataRoot)}`,
      `chown -R ${SANDBOX_USER}:${SANDBOX_USER} ${shellQuote(layout.workspaceRoot)}`,
      `chown root:root ${shellQuote(layout.metadataRoot)}`,
      `chmod 700 ${shellQuote(layout.metadataRoot)}`,
    ].join(" && "),
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
  await input.sandbox.commands.run(`git -C ${shellQuote(layout.workRoot)} init -q`, {
    user: SANDBOX_USER,
    timeoutMs: 30_000,
  });
  await input.sandbox.files.write(layout.agentFile, input.agentFile, {
    user: SANDBOX_ROOT_USER,
    requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
  });
  await input.sandbox.commands.run(
    `chown root:root ${shellQuote(layout.agentFile)} && chmod 600 ${shellQuote(layout.agentFile)}`,
    { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  );
}

export async function runSandboxTool(input: {
  sandbox: SandboxHandle;
  workdir: string;
  name: string;
  args: unknown;
  onOutput?: (stream: "stdout" | "stderr", delta: string) => Promise<void> | void;
}) {
  const args = asRecord(input.args);

  if (input.name === "shell") {
    const command = readString(args, "command");
    const layout = sandboxLayout(input.workdir);
    const result = await input.sandbox.commands.run(command, {
      cwd: layout.workRoot,
      timeoutMs: 120_000,
      onStdout: async (data: string) => {
        await input.onOutput?.("stdout", data);
      },
      onStderr: async (data: string) => {
        await input.onOutput?.("stderr", data);
      },
    });
    return truncate({
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    });
  }

  if (input.name === "read_file") {
    const filePath = resolveSandboxToolPath(input.workdir, readString(args, "path"));
    return truncate({
      path: relativePath(input.workdir, filePath),
      content: await input.sandbox.files.read(filePath),
    });
  }

  if (input.name === "write_file") {
    const filePath = resolveSandboxToolPath(input.workdir, readString(args, "path"));
    const content = readString(args, "content");
    await input.sandbox.commands.run(`mkdir -p ${shellQuote(path.posix.dirname(filePath))}`, {
      timeoutMs: 30_000,
    });
    await input.sandbox.files.write(filePath, content);
    return {
      path: relativePath(input.workdir, filePath),
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }

  if (input.name === "list_files") {
    const dirPath = resolveSandboxToolPath(input.workdir, readOptionalString(args, "path"));
    const depth = Math.min(Math.max(readOptionalNumber(args, "depth") ?? 2, 1), 5);
    const toolRelativePath = relativePath(input.workdir, dirPath);
    const result = await input.sandbox.commands.run(
      `find ${shellQuote(toolRelativePath)} -maxdepth ${depth} -print | sort | head -200`,
      { cwd: input.workdir, timeoutMs: 30_000 },
    );
    return truncate({
      path: toolRelativePath,
      entries: String(result.stdout ?? "")
        .split("\n")
        .filter(Boolean),
    });
  }

  if (input.name === "git_diff") {
    const layout = sandboxLayout(input.workdir);
    const result = await input.sandbox.commands.run(
      [
        `git -C ${shellQuote(layout.workRoot)} diff --`,
        `git -C ${shellQuote(layout.workRoot)} ls-files --others --exclude-standard | while IFS= read -r file; do git -C ${shellQuote(layout.workRoot)} diff --no-index -- /dev/null "$file" || true; done`,
      ].join(" && "),
      {
        timeoutMs: 60_000,
      },
    );
    return truncate({ diff: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") });
  }

  throw new Error(`Unknown tool: ${input.name}`);
}

export function resolveSandboxToolPath(workdir: string, inputPath = "work") {
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workdir, inputPath);
  } catch {
    throw new Error("Path must be inside work/ or brain/ for this session.");
  }
  const relative = relativePath(workdir, resolved);

  if (
    relative === "work" ||
    relative.startsWith("work/") ||
    relative === "brain" ||
    relative.startsWith("brain/")
  ) {
    return resolved;
  }

  throw new Error("Path must be inside work/ or brain/ for this session.");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Tool argument ${key} must be a string.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function relativePath(workdir: string, filePath: string) {
  return path.posix.relative(workdir, filePath);
}

function isSandboxNotFound(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "SandboxNotFoundError" || /not found|404/i.test(error.message);
}

function truncate<T extends Record<string, unknown>>(value: T): T {
  const next = { ...value };
  for (const [key, item] of Object.entries(next)) {
    if (typeof item === "string" && item.length > 24_000) {
      next[key as keyof T] = `${item.slice(0, 24_000)}\n...[truncated]` as T[keyof T];
    }
  }
  return next;
}
