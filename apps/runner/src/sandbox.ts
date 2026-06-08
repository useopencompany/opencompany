import path from "node:path";
import {
  MEMORY_CLI_FILE,
  parseGitHubCliArgs,
  resolveWorkspacePath,
  shellQuote,
} from "@opencompany/agent-runtime";
import { Sandbox } from "e2b";

export type SandboxHandle = Awaited<ReturnType<typeof Sandbox.create>>;
export type SandboxLatencyObservation = {
  operation: "create" | "connect";
  outcome: "success" | "not_found" | "error";
  latencyMs: number;
  sandboxId?: string;
  requestedSandboxId?: string;
  errorName?: string;
};

const ACTIVE_SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;
const SANDBOX_REQUEST_TIMEOUT_MS = 30_000;
const SANDBOX_USER = "user";
const SANDBOX_ROOT_USER = "root";
const METADATA_ROOT = "/home/user/.opencompany";
const GITHUB_AUTH_HEADER_ENV = "GITHUB_AUTH_HEADER";

type SandboxPreparationContext = {
  stage: string;
  command: string;
  repositoryFullName?: string | undefined;
  defaultBranch?: string | undefined;
};

export class SandboxPreparationError extends Error {
  readonly stage: string;
  readonly command: string;
  readonly repositoryFullName: string | undefined;
  readonly defaultBranch: string | undefined;
  override readonly cause: unknown;

  constructor(context: SandboxPreparationContext, cause: unknown) {
    super(`Sandbox preparation failed during ${context.stage}: ${errorMessage(cause)}`);
    this.name = "SandboxPreparationError";
    this.stage = context.stage;
    this.command = context.command;
    this.repositoryFullName = context.repositoryFullName;
    this.defaultBranch = context.defaultBranch;
    this.cause = cause;
  }
}

export function sandboxPreparationErrorFields(error: unknown) {
  const preparationError = error instanceof SandboxPreparationError ? error : null;
  if (!preparationError) return {};

  return {
    sandbox_stage: preparationError.stage,
    sandbox_command: preparationError.command,
    repository_full_name: preparationError.repositoryFullName,
    repository_default_branch: preparationError.defaultBranch,
    cause_name: errorName(preparationError.cause),
    cause_message: errorMessage(preparationError.cause),
  };
}

export function sandboxLayout(workdir: string) {
  return {
    workspaceRoot: workdir,
    agentRoot: `${workdir}/agent`,
    brainRoot: `${workdir}/brain`,
    workRoot: `${workdir}/work`,
    skillsRoot: `${workdir}/skills`,
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
  onLatency?: (observation: SandboxLatencyObservation) => void | Promise<void>;
}) {
  if (input.sandboxId) {
    const startedAt = performance.now();
    try {
      const sandbox = await Sandbox.connect(input.sandboxId, {
        timeoutMs: ACTIVE_SANDBOX_TIMEOUT_MS,
        requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
      });
      emitSandboxLatency(input.onLatency, {
        operation: "connect",
        outcome: "success",
        latencyMs: elapsedMs(startedAt),
        sandboxId: sandbox.sandboxId,
        requestedSandboxId: input.sandboxId,
      });
      return sandbox;
    } catch (error) {
      if (!isSandboxNotFound(error)) {
        const name = errorName(error);
        emitSandboxLatency(input.onLatency, {
          operation: "connect",
          outcome: "error",
          latencyMs: elapsedMs(startedAt),
          requestedSandboxId: input.sandboxId,
          ...(name ? { errorName: name } : {}),
        });
        throw error;
      }
      const name = errorName(error);
      emitSandboxLatency(input.onLatency, {
        operation: "connect",
        outcome: "not_found",
        latencyMs: elapsedMs(startedAt),
        requestedSandboxId: input.sandboxId,
        ...(name ? { errorName: name } : {}),
      });
    }
  }

  return createSandbox(input);
}

async function createSandbox(input: {
  template?: string | undefined;
  envs: Record<string, string>;
  idleTimeoutMs: number;
  onLatency?: (observation: SandboxLatencyObservation) => void | Promise<void>;
}) {
  const options = {
    envs: input.envs,
    timeoutMs: input.idleTimeoutMs,
    lifecycle: {
      onTimeout: "pause" as const,
      autoResume: true,
    },
  };

  const startedAt = performance.now();
  let sandbox: SandboxHandle;
  try {
    sandbox = input.template
      ? await Sandbox.create(input.template, options)
      : await Sandbox.create(options);
    emitSandboxLatency(input.onLatency, {
      operation: "create",
      outcome: "success",
      latencyMs: elapsedMs(startedAt),
      sandboxId: sandbox.sandboxId,
    });
  } catch (error) {
    const name = errorName(error);
    emitSandboxLatency(input.onLatency, {
      operation: "create",
      outcome: "error",
      latencyMs: elapsedMs(startedAt),
      ...(name ? { errorName: name } : {}),
    });
    throw error;
  }
  await sandbox.setTimeout(ACTIVE_SANDBOX_TIMEOUT_MS, {
    requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
  });
  return sandbox;
}

function emitSandboxLatency(
  onLatency: ((observation: SandboxLatencyObservation) => void | Promise<void>) | undefined,
  observation: SandboxLatencyObservation,
) {
  try {
    void Promise.resolve(onLatency?.(observation)).catch(() => {});
  } catch {
    // Analytics must not affect sandbox provisioning.
  }
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
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

  await runSandboxPreparationCommand({
    sandbox: input.sandbox,
    stage: "create_workspace_layout",
    commandName: "mkdir_chown_metadata",
    command: [
      `mkdir -p ${shellQuote(layout.agentRoot)} ${shellQuote(layout.brainRoot)} ${shellQuote(layout.workRoot)} ${shellQuote(layout.metadataRoot)}`,
      `chown -R ${SANDBOX_USER}:${SANDBOX_USER} ${shellQuote(layout.workspaceRoot)}`,
      `chown root:root ${shellQuote(layout.metadataRoot)}`,
      `chmod 700 ${shellQuote(layout.metadataRoot)}`,
    ].join(" && "),
    options: { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  });
  // The session starts with an empty work/ directory. Repositories are cloned on
  // demand by the agent (git/gh in the shell) or by amp; nothing is cloned here.
  await runSandboxPreparationCommand({
    sandbox: input.sandbox,
    stage: "initialize_empty_work_repository",
    commandName: "git_init",
    command: `git -C ${shellQuote(layout.workRoot)} init -q`,
    options: {
      user: SANDBOX_USER,
      timeoutMs: 30_000,
    },
  });
  await input.sandbox.files.write(layout.agentFile, input.agentFile, {
    user: SANDBOX_ROOT_USER,
    requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
  });
  await runSandboxPreparationCommand({
    sandbox: input.sandbox,
    stage: "secure_agent_file",
    commandName: "chmod_agent_file",
    command: `chown root:root ${shellQuote(layout.agentFile)} && chmod 600 ${shellQuote(layout.agentFile)}`,
    options: { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  });
}

async function runSandboxPreparationCommand(input: {
  sandbox: SandboxHandle;
  stage: string;
  commandName: string;
  command: string;
  options?: Parameters<SandboxHandle["commands"]["run"]>[1];
  repositoryFullName?: string;
  defaultBranch?: string;
}) {
  try {
    return await input.sandbox.commands.run(input.command, input.options);
  } catch (error) {
    throw new SandboxPreparationError(
      {
        stage: input.stage,
        command: input.commandName,
        repositoryFullName: input.repositoryFullName,
        defaultBranch: input.defaultBranch,
      },
      error,
    );
  }
}

export async function cloneGitHubRepositoryIntoWorkdir(input: {
  sandbox: SandboxHandle;
  workdir: string;
  repositoryFullName: string;
  defaultBranch: string;
  githubToken: string;
}) {
  const origin = await runSandboxPreparationCommand({
    sandbox: input.sandbox,
    stage: "inspect_work_repository",
    commandName: "git_remote_get_url",
    command: [
      `if [ -d ${shellQuote(`${input.workdir}/.git`)} ]; then`,
      `  cd ${shellQuote(input.workdir)} && git remote get-url origin 2>/dev/null || true;`,
      "else",
      "  echo __opencompany_missing_git__;",
      "fi;",
    ].join("\n"),
    options: { timeoutMs: 30_000 },
    repositoryFullName: input.repositoryFullName,
    defaultBranch: input.defaultBranch,
  });
  const currentOrigin = String(origin.stdout ?? "").trim();
  const cloneUrl = githubRemoteUrl(input.repositoryFullName);
  if (githubRemoteMatches(currentOrigin, input.repositoryFullName)) {
    await runSandboxPreparationCommand({
      sandbox: input.sandbox,
      stage: "refresh_work_repository_remote",
      commandName: "git_remote_set_url",
      command: `cd ${shellQuote(input.workdir)} && git remote set-url origin ${shellQuote(cloneUrl)}`,
      options: {
        envs: { [GITHUB_AUTH_HEADER_ENV]: gitAuthHeader(input.githubToken) },
        timeoutMs: 30_000,
      },
      repositoryFullName: input.repositoryFullName,
      defaultBranch: input.defaultBranch,
    });
    return;
  }

  await runSandboxPreparationCommand({
    sandbox: input.sandbox,
    stage: "clone_work_repository",
    commandName: "git_clone",
    command: [
      `rm -rf ${shellQuote(input.workdir)}`,
      `git ${gitAuthExtraHeaderArg()} clone --depth 1 --branch ${shellQuote(
        input.defaultBranch,
      )} ${shellQuote(cloneUrl)} ${shellQuote(input.workdir)}`,
    ].join(" && "),
    options: {
      envs: { [GITHUB_AUTH_HEADER_ENV]: gitAuthHeader(input.githubToken) },
      timeoutMs: 120_000,
    },
    repositoryFullName: input.repositoryFullName,
    defaultBranch: input.defaultBranch,
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : undefined;
}

function gitAuthHeader(token: string) {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  )}`;
}

export async function runSandboxTool(input: {
  sandbox: SandboxHandle;
  workdir: string;
  name: string;
  args: unknown;
  envs?: Record<string, string> | undefined;
  redactOutput?: ((value: string) => string) | undefined;
  onOutput?: (stream: "stdout" | "stderr", delta: string) => Promise<void> | void;
}) {
  const args = asRecord(input.args);
  const redact = input.redactOutput ?? ((value: string) => value);

  if (input.name === "shell") {
    const command = readString(args, "command");
    const layout = sandboxLayout(input.workdir);
    const result = await runCommandWithExitResult(input.sandbox, command, {
      cwd: layout.workspaceRoot,
      ...(input.envs ? { envs: input.envs } : {}),
      timeoutMs: 120_000,
      onStdout: async (data: string) => {
        await input.onOutput?.("stdout", redact(data));
      },
      onStderr: async (data: string) => {
        await input.onOutput?.("stderr", redact(data));
      },
    });
    return truncate({
      stdout: redact(String(result.stdout ?? "")),
      stderr: redact(String(result.stderr ?? "")),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    });
  }

  if (input.name === "gh") {
    const ghArgv = parseGitHubCliArgs(readString(args, "args"));
    if (!ghArgv || ghArgv.length === 0) {
      throw new Error("GitHub CLI arguments are empty or malformed.");
    }
    const layout = sandboxLayout(input.workdir);
    const command = ["gh", ...ghArgv.map(shellQuote)].join(" ");
    const result = await runCommandWithExitResult(input.sandbox, command, {
      cwd: layout.workRoot,
      ...(input.envs ? { envs: input.envs } : {}),
      timeoutMs: 120_000,
      onStdout: async (data: string) => {
        await input.onOutput?.("stdout", redact(data));
      },
      onStderr: async (data: string) => {
        await input.onOutput?.("stderr", redact(data));
      },
    });
    return truncate({
      stdout: redact(String(result.stdout ?? "")),
      stderr: redact(String(result.stderr ?? "")),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    });
  }

  if (input.name === "memory") {
    const memoryArgv = parseGitHubCliArgs(readString(args, "args"));
    if (!memoryArgv || memoryArgv.length === 0) {
      throw new Error("Memory CLI arguments are empty or malformed.");
    }
    const layout = sandboxLayout(input.workdir);
    // The CLI bundle is delivered to the read-only skills mount (see apps/runner/src/skills.ts).
    // Build the command from the parsed, shell-quoted argv so the agent only controls argv tokens
    // and cannot break out to read the injected Gateway key. --report-usage makes the CLI emit its
    // model-backed retrieval footprint on stderr for billing.
    const cliPath = `${layout.skillsRoot}/memory/${MEMORY_CLI_FILE}`;
    const command = [
      "bun",
      shellQuote(cliPath),
      ...memoryArgv.map(shellQuote),
      "--report-usage",
    ].join(" ");
    const result = await runCommandWithExitResult(input.sandbox, command, {
      cwd: layout.workspaceRoot,
      ...(input.envs ? { envs: input.envs } : {}),
      timeoutMs: 120_000,
      onStdout: async (data: string) => {
        await input.onOutput?.("stdout", redact(data));
      },
      onStderr: async (data: string) => {
        await input.onOutput?.("stderr", redact(data));
      },
    });
    return truncate({
      stdout: redact(String(result.stdout ?? "")),
      stderr: redact(String(result.stderr ?? "")),
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

  if (input.name === "read_skill") {
    const filePath = resolveSandboxSkillPath(
      input.workdir,
      readString(args, "skillId"),
      readOptionalString(args, "path"),
    );
    const toolRelativePath = relativePath(input.workdir, filePath);
    try {
      return truncate({
        path: toolRelativePath,
        content: await input.sandbox.files.read(filePath),
      });
    } catch {
      throw new Error(`Skill file not found or unreadable: ${toolRelativePath}.`);
    }
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

  if (input.name === "edit_file") {
    const filePath = resolveSandboxToolPath(input.workdir, readString(args, "path"));
    const toolRelativePath = relativePath(input.workdir, filePath);
    readString(args, "instructions");
    const edits = readEditOperations(args);
    let content: string;
    try {
      content = await input.sandbox.files.read(filePath);
    } catch {
      throw new Error(
        `File not found or unreadable: ${toolRelativePath}. Use write_file to create new files.`,
      );
    }

    const originalContent = content;
    let replacements = 0;
    for (const [index, edit] of edits.entries()) {
      const count = countOccurrences(content, edit.oldString);
      if (count === 0) {
        const crlfHint =
          content.includes("\r\n") &&
          !edit.oldString.includes("\r\n") &&
          edit.oldString.includes("\n")
            ? " The file uses CRLF (\\r\\n) line endings; include them in oldString."
            : "";
        throw new Error(
          `Edit ${index + 1} failed: oldString was not found in ${toolRelativePath}.${crlfHint}`,
        );
      }
      if (!edit.replaceAll && count > 1) {
        const cascadeHint =
          index > 0
            ? " A previous edit may have created additional matches — try descending order, more surrounding context, or replaceAll."
            : "";
        throw new Error(
          `Edit ${index + 1} failed: oldString matched ${count} times in ${toolRelativePath}. Include more context or set replaceAll=true.${cascadeHint}`,
        );
      }

      content = edit.replaceAll
        ? content.split(edit.oldString).join(edit.newString)
        : replaceFirst(content, edit.oldString, edit.newString);
      replacements += edit.replaceAll ? count : 1;
    }

    if (content === originalContent) {
      throw new Error(
        edits.length > 1
          ? `No net change to ${toolRelativePath} (edits cancel each other). Re-check the edit order or merge into a single edit.`
          : `No changes made to ${toolRelativePath}.`,
      );
    }

    await input.sandbox.files.write(filePath, content);
    return {
      path: toolRelativePath,
      editsApplied: edits.length,
      replacements,
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
    const result = await input.sandbox.commands.run(gitDiffCommand(layout.workRoot), {
      timeoutMs: 60_000,
    });
    return truncate({ diff: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") });
  }

  throw new Error(`Unknown tool: ${input.name}`);
}

async function runCommandWithExitResult(
  sandbox: SandboxHandle,
  command: string,
  options: Parameters<SandboxHandle["commands"]["run"]>[1],
) {
  try {
    return await sandbox.commands.run(command, options);
  } catch (error) {
    const exitResult = commandExitResult(error);
    if (exitResult) return exitResult;
    throw error;
  }
}

function commandExitResult(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (record.name !== "CommandExitError") return null;
  if (typeof record.exitCode !== "number") return null;

  return {
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    exitCode: record.exitCode,
  };
}

function gitDiffCommand(workRoot: string) {
  return [
    `WORK=${shellQuote(workRoot)}`,
    "emit_repo_diff() {",
    '  repo="$1"',
    '  label="$2"',
    '  skip_nested="${3:-0}"',
    '  [ -d "$repo/.git" ] || return 0',
    '  body="$(',
    '    git -C "$repo" status --short | while IFS= read -r line; do',
    '      if [ "$skip_nested" = "1" ]; then',
    '        path="${line#?? }"',
    '        first="${path%%/*}"',
    '        if [ -n "$first" ] && [ -d "$repo/$first/.git" ]; then',
    "          continue",
    "        fi",
    "      fi",
    '      printf "%s\\n" "$line"',
    "    done",
    '    git -C "$repo" diff --cached --',
    '    git -C "$repo" diff --',
    '    git -C "$repo" ls-files --others --exclude-standard | while IFS= read -r file; do',
    '      [ -n "$file" ] || continue',
    '      if [ "$skip_nested" = "1" ]; then',
    '        first="${file%%/*}"',
    '        if [ -n "$first" ] && [ -d "$repo/$first/.git" ]; then',
    "          continue",
    "        fi",
    "      fi",
    '      if [ -f "$repo/$file" ]; then',
    '        git -C "$repo" diff --no-index -- /dev/null "$file" || true',
    "      fi",
    "    done",
    '  )"',
    '  if [ -n "$body" ]; then',
    '    printf -- "--- %s ---\\n%s\\n" "$label" "$body"',
    "  fi",
    "}",
    'emit_repo_diff "$WORK" "work/" "1"',
    'find "$WORK" -mindepth 2 -maxdepth 2 -type d -name .git -print | sort | while IFS= read -r git_dir; do',
    '  repo_dir="$(dirname "$git_dir")"',
    '  repo_name="${repo_dir##*/}"',
    '  emit_repo_diff "$repo_dir" "work/$repo_name/"',
    "done",
  ].join("\n");
}

export function resolveSandboxToolPath(workdir: string, inputPath = "work") {
  const allowedRootsMessage = "Path must be inside work/, brain/, or agent/ for this session.";
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workdir, inputPath);
  } catch {
    throw new Error(allowedRootsMessage);
  }
  const relative = relativePath(workdir, resolved);

  const inAllowedRoot =
    relative === "work" ||
    relative.startsWith("work/") ||
    relative === "brain" ||
    relative.startsWith("brain/") ||
    relative === "agent" ||
    relative.startsWith("agent/");

  if (inAllowedRoot) {
    return resolved;
  }

  throw new Error(allowedRootsMessage);
}

/**
 * If a tool path resolves inside the Brain root, return its Brain-relative path
 * (without the `brain/` prefix; `""` for the Brain root). Returns null when the
 * path is valid but outside the Brain. Throws the same error as
 * resolveSandboxToolPath when the path is not in an allowed root at all.
 */
export function resolveSandboxBrainRelativePath(
  workdir: string,
  inputPath?: string,
): string | null {
  const resolved = resolveSandboxToolPath(workdir, inputPath);
  const relative = relativePath(workdir, resolved);
  if (relative === "brain") return "";
  if (relative.startsWith("brain/")) return relative.slice("brain/".length);
  return null;
}

export function resolveSandboxSkillPath(workdir: string, skillId: string, inputPath = "SKILL.md") {
  const id = skillId.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id) || id.includes("--")) {
    throw new Error("Skill id must be a valid mounted skill id.");
  }

  const relativeFilePath = inputPath.trim() || "SKILL.md";
  if (
    relativeFilePath.includes("\0") ||
    path.posix.isAbsolute(relativeFilePath) ||
    relativeFilePath === "." ||
    relativeFilePath.split("/").includes("..") ||
    relativeFilePath.endsWith("/")
  ) {
    throw new Error("Skill path must be a relative file path inside the skill directory.");
  }

  const resolved = resolveWorkspacePath(workdir, path.posix.join("skills", id, relativeFilePath));
  const relative = relativePath(workdir, resolved);
  const skillRoot = `skills/${id}`;

  if (relative !== skillRoot && relative.startsWith(`${skillRoot}/`)) {
    return resolved;
  }

  throw new Error("Skill path must stay inside the requested skill directory.");
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

type EditOperation = {
  oldString: string;
  newString: string;
  replaceAll: boolean;
};

function readEditOperations(record: Record<string, unknown>): EditOperation[] {
  const value = record.edits;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Tool argument edits must be a non-empty array.");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Edit ${index + 1} must be an object with oldString and newString.`);
    }
    const edit = item as Record<string, unknown>;
    if (typeof edit.oldString !== "string") {
      throw new Error(`Edit ${index + 1} oldString must be a string.`);
    }
    if (edit.oldString === "") {
      throw new Error(`Edit ${index + 1} oldString must not be empty.`);
    }
    if (typeof edit.newString !== "string") {
      throw new Error(`Edit ${index + 1} newString must be a string.`);
    }
    const replaceAllValue = edit.replaceAll;
    if (replaceAllValue !== undefined && typeof replaceAllValue !== "boolean") {
      throw new Error(`Edit ${index + 1} replaceAll must be a boolean when provided.`);
    }

    return {
      oldString: edit.oldString,
      newString: edit.newString,
      replaceAll: replaceAllValue === true,
    };
  });
}

function countOccurrences(content: string, needle: string) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function replaceFirst(content: string, oldString: string, newString: string) {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return `${content.slice(0, index)}${newString}${content.slice(index + oldString.length)}`;
}

function relativePath(workdir: string, filePath: string) {
  return path.posix.relative(workdir, filePath);
}

function isSandboxNotFound(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "SandboxNotFoundError" || /not found|404/i.test(error.message);
}

function githubRemoteUrl(repositoryFullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error("Invalid GitHub repository name for workspace clone.");
  }

  return `https://github.com/${repositoryFullName}.git`;
}

function gitAuthExtraHeaderArg() {
  return `-c http.extraheader="$${GITHUB_AUTH_HEADER_ENV}"`;
}

export function githubRemoteMatches(remote: string, repositoryFullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error("Invalid GitHub repository name for workspace clone.");
  }

  const escaped = repositoryFullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(?:https://github\\.com/|https://x-access-token:[^@]+@github\\.com/|git@github\\.com:)${escaped}(?:\\.git)?$`,
  ).test(remote.trim());
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
