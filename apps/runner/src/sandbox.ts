import { resolveWorkspacePath, shellQuote } from "@opencompany/agent-runtime";
import { Sandbox } from "e2b";
import path from "node:path";

export type SandboxHandle = Awaited<ReturnType<typeof Sandbox.create>>;

export async function createOrConnectSandbox(input: {
  sandboxId?: string | null;
  template?: string | undefined;
  envs: Record<string, string>;
}) {
  if (input.sandboxId) {
    return Sandbox.connect(input.sandboxId);
  }

  const options = {
    envs: input.envs,
    timeoutMs: 60 * 60 * 1000,
  };

  return input.template ? Sandbox.create(input.template, options) : Sandbox.create(options);
}

export async function prepareWorkspace(input: {
  sandbox: SandboxHandle;
  workdir: string;
  agentFile: string;
  repositoryFullName?: string | null | undefined;
  githubToken?: string | null | undefined;
}) {
  if (input.repositoryFullName && input.githubToken) {
    const cloneUrl = githubCloneUrl(input.repositoryFullName);
    await input.sandbox.commands.run(
      [
        `if [ ! -d ${shellQuote(`${input.workdir}/.git`)} ]; then`,
        `  rm -rf ${shellQuote(input.workdir)};`,
        `  git clone --depth 1 "${cloneUrl}" ${shellQuote(input.workdir)};`,
        "fi;",
      ].join("\n"),
      { envs: { GITHUB_TOKEN: input.githubToken }, timeoutMs: 120_000 },
    );
  }

  await input.sandbox.commands.run(`mkdir -p ${shellQuote(input.workdir)} ${shellQuote(`${input.workdir}/.opencompany`)}`);
  await input.sandbox.files.write(`${input.workdir}/.opencompany/agent.md`, input.agentFile);
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
    const result = await input.sandbox.commands.run(`cd ${shellQuote(input.workdir)} && ${command}`, {
      timeoutMs: 120_000,
      onStdout: (data: string) => input.onOutput?.("stdout", data),
      onStderr: (data: string) => input.onOutput?.("stderr", data),
    });
    return truncate({
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    });
  }

  if (input.name === "read_file") {
    const filePath = resolveWorkspacePath(input.workdir, readString(args, "path"));
    return truncate({ path: relativePath(input.workdir, filePath), content: await input.sandbox.files.read(filePath) });
  }

  if (input.name === "write_file") {
    const filePath = resolveWorkspacePath(input.workdir, readString(args, "path"));
    const content = readString(args, "content");
    await input.sandbox.commands.run(`mkdir -p ${shellQuote(path.posix.dirname(filePath))}`);
    await input.sandbox.files.write(filePath, content);
    return { path: relativePath(input.workdir, filePath), bytes: Buffer.byteLength(content, "utf8") };
  }

  if (input.name === "list_files") {
    const dirPath = resolveWorkspacePath(input.workdir, readOptionalString(args, "path") ?? ".");
    const depth = Math.min(Math.max(readOptionalNumber(args, "depth") ?? 2, 1), 5);
    const result = await input.sandbox.commands.run(
      `cd ${shellQuote(input.workdir)} && find ${shellQuote(relativePath(input.workdir, dirPath) || ".")} -maxdepth ${depth} -print | sort | head -200`,
      { timeoutMs: 30_000 },
    );
    return truncate({ path: relativePath(input.workdir, dirPath) || ".", entries: String(result.stdout ?? "").split("\n").filter(Boolean) });
  }

  if (input.name === "git_diff") {
    const result = await input.sandbox.commands.run(`cd ${shellQuote(input.workdir)} && git diff --`, {
      timeoutMs: 60_000,
    });
    return truncate({ diff: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") });
  }

  throw new Error(`Unknown tool: ${input.name}`);
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

function githubCloneUrl(repositoryFullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error("Invalid GitHub repository name for workspace clone.");
  }

  return `https://x-access-token:$GITHUB_TOKEN@github.com/${repositoryFullName}.git`;
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
