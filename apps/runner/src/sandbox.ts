import path from "node:path";
import {
  MEMORY_CLI_FILE,
  parseGitHubCliArgs,
  resolveWorkspacePath,
  shellQuote,
} from "@opencompany/agent-runtime";
import { Sandbox } from "e2b";
import { gitHubPermissionErrorHint } from "./github";

export type SandboxHandle = Awaited<ReturnType<typeof Sandbox.create>>;
export type SandboxTextFile = {
  path: string;
  content: string | Uint8Array;
};
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

// The session sandbox has two layout variants. The company/workspace agent keeps the original tree
// (agent/, brain/, work/). The personal-agent-first pivot promotes the personal agent's two durable
// spaces to the top level — memory/ (the agent's structured self-knowledge, MEMORY_ROOT) and
// personal-brain/ (the user's private knowledge files) — so a personal session's tree reads as
// memory/ + personal-brain/ + work/. agent/ is retained (smaller) for the agent's private profile,
// soul, and writable skill authoring (which must not collide with the read-only skills/ mount), and
// personal agents have no company brain/ mount. `personal` selects the variant; all other roots are
// identical so non-personal-aware call sites are unaffected.
export function sandboxLayout(workdir: string, personal = false) {
  return {
    workspaceRoot: workdir,
    agentRoot: `${workdir}/agent`,
    brainRoot: `${workdir}/brain`,
    codexRoot: `${workdir}/codex`,
    workRoot: `${workdir}/work`,
    skillsRoot: `${workdir}/skills`,
    // Personal: memory/ is its own top-level root. Company: it stays under the agent bundle.
    memoryRoot: personal ? `${workdir}/memory` : `${workdir}/agent/memory`,
    // Only mounted for personal sessions; null for company so the difference is explicit.
    personalBrainRoot: personal ? `${workdir}/personal-brain` : null,
    metadataRoot: METADATA_ROOT,
    agentFile: `${METADATA_ROOT}/agent.agent`,
    brainManifest: `${METADATA_ROOT}/brain-manifest.json`,
    personal,
  };
}

export async function createOrConnectSandbox(input: {
  sandboxId?: string | null;
  template?: string | undefined;
  envs: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  idleTimeoutMs: number;
  onLatency?: (observation: SandboxLatencyObservation) => void | Promise<void>;
}) {
  if (input.sandboxId) {
    const sandbox = await connectSandbox({
      sandboxId: input.sandboxId,
      ...(input.onLatency ? { onLatency: input.onLatency } : {}),
    });
    if (sandbox) return sandbox;
  }

  return createSandbox(input);
}

export async function connectSandbox(input: {
  sandboxId: string;
  onLatency?: (observation: SandboxLatencyObservation) => void | Promise<void>;
}) {
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
    const name = errorName(error);
    if (!isSandboxNotFound(error)) {
      emitSandboxLatency(input.onLatency, {
        operation: "connect",
        outcome: "error",
        latencyMs: elapsedMs(startedAt),
        requestedSandboxId: input.sandboxId,
        ...(name ? { errorName: name } : {}),
      });
      throw error;
    }
    emitSandboxLatency(input.onLatency, {
      operation: "connect",
      outcome: "not_found",
      latencyMs: elapsedMs(startedAt),
      requestedSandboxId: input.sandboxId,
      ...(name ? { errorName: name } : {}),
    });
    return null;
  }
}

async function createSandbox(input: {
  template?: string | undefined;
  envs: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  idleTimeoutMs: number;
  onLatency?: (observation: SandboxLatencyObservation) => void | Promise<void>;
}) {
  const options = {
    envs: input.envs,
    ...(input.metadata ? { metadata: input.metadata } : {}),
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

export type SandboxLifecycleStatus = "running" | "sleeping" | "deleted";

export async function getSandboxLifecycleStatus(
  sandboxId: string,
): Promise<SandboxLifecycleStatus> {
  try {
    const info = await Sandbox.getInfo(sandboxId, {
      requestTimeoutMs: SANDBOX_REQUEST_TIMEOUT_MS,
    });
    return info.state === "paused" ? "sleeping" : "running";
  } catch (error) {
    if (isSandboxNotFound(error)) return "deleted";
    throw error;
  }
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
  personal?: boolean;
  createCodexRoot?: boolean;
  configureGitCredentialHelper?: boolean;
}) {
  const layout = sandboxLayout(input.workdir, input.personal ?? false);
  const configureGitCredentialHelper = input.configureGitCredentialHelper ?? true;

  // Personal sessions get memory/ + personal-brain/ at the top level instead of a company brain/
  // mount; agent/ is still created for the agent's private profile/soul/skill authoring.
  const layoutDirs = layout.personal
    ? [layout.agentRoot, layout.memoryRoot, layout.personalBrainRoot, layout.workRoot]
    : [layout.agentRoot, layout.brainRoot, layout.workRoot];
  if (input.createCodexRoot) {
    layoutDirs.push(layout.codexRoot);
  }

  await runSandboxPreparationCommand({
    sandbox: input.sandbox,
    stage: "create_workspace_layout",
    commandName: "mkdir_git_init_chown_metadata",
    command: [
      `mkdir -p ${layoutDirs
        .filter((dir): dir is string => Boolean(dir))
        .map(shellQuote)
        .join(" ")} ${shellQuote(layout.metadataRoot)}`,
      `git -C ${shellQuote(layout.workRoot)} init -q`,
      `chown -R ${SANDBOX_USER}:${SANDBOX_USER} ${shellQuote(layout.workspaceRoot)}`,
      `chown root:root ${shellQuote(layout.metadataRoot)}`,
      `chmod 700 ${shellQuote(layout.metadataRoot)}`,
    ].join(" && "),
    options: { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  });
  await runSandboxPreparationCommand({
    sandbox: input.sandbox,
    stage: "write_agent_file",
    commandName: "write_agent_file",
    command: [
      `printf %s ${shellQuote(Buffer.from(input.agentFile, "utf8").toString("base64"))} | base64 -d > ${shellQuote(layout.agentFile)}`,
      `chown root:root ${shellQuote(layout.agentFile)}`,
      `chmod 600 ${shellQuote(layout.agentFile)}`,
    ].join(" && "),
    options: { user: SANDBOX_ROOT_USER, timeoutMs: 30_000 },
  });
  // Wire git to GitHub's credential helper so plain `git push` / `git clone https://github.com/...`
  // work whenever a GH token is present in the command env (the coding tools inject one) instead of
  // failing with "could not read Username for github.com". Equivalent to `gh auth setup-git` but set
  // directly so it does not require gh to be authenticated at prepare time. Written to the `user`
  // global gitconfig — the same user the shell tool runs as.
  if (configureGitCredentialHelper) {
    await runSandboxPreparationCommand({
      sandbox: input.sandbox,
      stage: "configure_git_credential_helper",
      commandName: "git_config_credential_helper",
      command: [
        `git config --global --replace-all ${shellQuote("credential.https://github.com.helper")} ${shellQuote("")}`,
        `git config --global --add ${shellQuote("credential.https://github.com.helper")} ${shellQuote("!gh auth git-credential")}`,
      ].join(" && "),
      options: { user: SANDBOX_USER, timeoutMs: 30_000 },
    });
  }
}

export async function writeSandboxTextFiles(input: {
  sandbox: SandboxHandle;
  files: SandboxTextFile[];
  user?: string | undefined;
}) {
  if (input.files.length === 0) return;

  const files = input.files.map((file) => ({
    path: file.path,
    data: sandboxFileContent(file.content),
  }));
  if (input.user) {
    await input.sandbox.files.write(files, { user: input.user });
    return;
  }
  await input.sandbox.files.write(files);
}

function sandboxFileContent(content: SandboxTextFile["content"]) {
  if (typeof content === "string") return content;
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  return copy.buffer;
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
  // True for the user's personal agent: selects the memory/ + personal-brain/ + work/ sandbox layout
  // and the matching path whitelist. Defaults false (company/workspace layout) so existing callers
  // are unaffected.
  personal?: boolean;
}) {
  const args = asRecord(input.args);
  const redact = input.redactOutput ?? ((value: string) => value);
  const personal = input.personal ?? false;

  if (input.name === "shell") {
    const command = readString(args, "command");
    const layout = sandboxLayout(input.workdir, personal);
    if (personalShellCommandReferencesMemory(command, layout)) {
      throw new Error(
        "Shell commands cannot access memory/ in personal sessions. Use the memory tool to read or write structured memory.",
      );
    }
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
    const stdout = redact(String(result.stdout ?? ""));
    const stderr = redact(String(result.stderr ?? ""));
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
    // Turn GitHub's opaque "Resource not accessible by integration" 403 into an actionable hint so
    // the agent stops retrying a permanently-blocked call (e.g. `gh issue create` when the App lacks
    // Issues:write) and an operator reading the result knows exactly which grant is missing. Only on
    // a FAILED command — otherwise a successful `gh pr view`/`gh issue view` whose body merely quotes
    // the phrase would get a spurious hint.
    const permissionHint =
      exitCode !== 0 ? gitHubPermissionErrorHint(`${stdout}\n${stderr}`, { ghArgv }) : null;
    return truncate({
      stdout,
      stderr,
      exitCode,
      ...(permissionHint ? { permissionHint } : {}),
    });
  }

  if (input.name === "memory") {
    const memoryArgv = parseGitHubCliArgs(readString(args, "args"));
    if (!memoryArgv || memoryArgv.length === 0) {
      throw new Error("Memory CLI arguments are empty or malformed.");
    }
    const layout = sandboxLayout(input.workdir, personal);
    // The CLI bundle is delivered to the read-only skills mount (see apps/runner/src/skills.ts).
    // Build the command from the parsed, shell-quoted argv so the agent only controls argv tokens
    // and cannot break out to read the injected Gateway key. --report-usage makes the CLI emit its
    // model-backed retrieval footprint on stderr for billing.
    const cliPath = `${layout.skillsRoot}/memory/${MEMORY_CLI_FILE}`;
    const command = [
      "node",
      shellQuote(cliPath),
      ...memoryArgv.map(shellQuote),
      "--report-usage",
    ].join(" ");
    // Pin the memory root to the agent's memory tree (top-level memory/ for personal, agent/memory
    // for company). The CLI treats MEMORY_ROOT as authoritative and ignores any agent-supplied
    // `--root` (see resolveRoot), so the agent cannot point the memory tool outside its tree even
    // though it controls every argv token.
    const memoryRoot = layout.memoryRoot;
    const result = await runCommandWithExitResult(input.sandbox, command, {
      cwd: layout.workspaceRoot,
      envs: { ...input.envs, MEMORY_ROOT: memoryRoot },
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
    const filePath = resolveSandboxToolPath(input.workdir, readString(args, "path"), personal);
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
    const filePath = resolveSandboxToolPath(input.workdir, readString(args, "path"), personal);
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
    const filePath = resolveSandboxToolPath(input.workdir, readString(args, "path"), personal);
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
    const dirPath = resolveSandboxToolPath(
      input.workdir,
      readOptionalString(args, "path"),
      personal,
    );
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

function personalShellCommandReferencesMemory(
  command: string,
  layout: ReturnType<typeof sandboxLayout>,
) {
  if (command.includes(layout.memoryRoot)) return true;
  return /(^|[\s"'`|&;()<>])(?:\.\/)?memory(?:\/|$|[\s"'`|&;()<>])/.test(command);
}

async function runCommandWithExitResult(
  sandbox: SandboxHandle,
  command: string,
  options: Parameters<SandboxHandle["commands"]["run"]>[1],
) {
  const guarded = guardCommandStreamCallbacks(options ?? {});
  const result = await sandbox.commands.run(command, guarded.options).catch(async (error) => {
    // A captured stream-callback error (typically RunAbortError) outranks the command's
    // own failure: it is the reason the run is unwinding.
    await guarded.rethrow();
    const exitResult = commandExitResult(error);
    if (!exitResult) throw error;
    return exitResult;
  });
  await guarded.rethrow();
  return result;
}

type CommandStreamCallback = (data: string) => void | Promise<void>;

/**
 * E2B's `CommandHandle.handleEvents` invokes `onStdout`/`onStderr` WITHOUT awaiting them,
 * so an async callback that rejects — e.g. the run-control gate throwing `RunAbortError`
 * when the user hits Stop mid-stream — becomes an unhandled promise rejection detached
 * from the awaited `commands.run` chain, which exits the whole multi-session Bun process
 * (prod crash 2026-06-10). This wraps the stream callbacks so they can never reject: the
 * first error is captured (later chunks are dropped) and surfaced via `rethrow()` at the
 * awaited boundary, where the regular tool-failure/abort handling can see it.
 */
export function guardCommandStreamCallbacks<
  T extends { onStdout?: CommandStreamCallback; onStderr?: CommandStreamCallback },
>(options: T): { options: T; rethrow: () => Promise<void> } {
  let failed = false;
  let callbackError: unknown;
  // Chain of in-flight callback invocations. `rethrow` waits for it so a rejection from
  // the final chunk — which e2b fires without awaiting, possibly in the same tick the
  // command result resolves — is still observed at the boundary. Links never reject
  // (errors are captured below), so the chain itself is safe to await.
  let settled: Promise<void> = Promise.resolve();

  const guard = (callback: CommandStreamCallback | undefined) =>
    callback &&
    ((data: string): Promise<void> => {
      if (failed) return Promise.resolve();
      const invocation = (async () => {
        try {
          await callback(data);
        } catch (error) {
          failed = true;
          callbackError = error;
        }
      })();
      settled = settled.then(() => invocation);
      return invocation;
    });

  return {
    options: {
      ...options,
      onStdout: guard(options.onStdout),
      onStderr: guard(options.onStderr),
    } as T,
    rethrow: async () => {
      await settled;
      if (failed) throw callbackError;
    },
  };
}

export function commandExitResult(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (record.name !== "CommandExitError") return null;
  const result = readRecordProperty(record, "result");
  const candidates = result ? [result, record] : [record];
  const exitCode =
    candidates.map((candidate) => readNumberProperty(candidate, "exitCode")).find(isNumber) ??
    candidates.map((candidate) => readNumberProperty(candidate, "exit_code")).find(isNumber);
  if (exitCode == null) return null;

  return {
    stdout:
      candidates.map((candidate) => readStringProperty(candidate, "stdout")).find(isString) ?? "",
    stderr:
      candidates.map((candidate) => readStringProperty(candidate, "stderr")).find(isString) ?? "",
    exitCode,
  };
}

function readRecordProperty(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  try {
    const value = record[key];
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readNumberProperty(record: Record<string, unknown>, key: string): number | null {
  try {
    const value = record[key];
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function readStringProperty(record: Record<string, unknown>, key: string): string | null {
  try {
    const value = record[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function isNumber(value: number | null): value is number {
  return typeof value === "number";
}

function isString(value: string | null): value is string {
  return typeof value === "string";
}

// E2B raises a `TimeoutError` when a command exceeds its `timeoutMs` (the process is killed
// server-side). Matched by name to stay decoupled from the SDK's class identity, mirroring
// `commandExitResult`. Lets long tool calls capture partial state instead of bubbling a bare throw.
export function isCommandTimeoutError(error: unknown) {
  return Boolean(
    error && typeof error === "object" && (error as { name?: unknown }).name === "TimeoutError",
  );
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

export function resolveSandboxToolPath(workdir: string, inputPath = "work", personal = false) {
  // Personal sessions mount memory/ for the dedicated memory CLI, but generic file tools must not
  // touch it because that bypasses structured-memory provenance and validation.
  const allowedRoots = personal ? ["work", "personal-brain", "agent"] : ["work", "brain", "agent"];
  const allowedRootsList = allowedRoots.map((root) => `${root}/`);
  // Oxford-"or" join so the company message stays "work/, brain/, or agent/".
  const allowedRootsMessage = `Path must be inside ${
    allowedRootsList.length > 1
      ? `${allowedRootsList.slice(0, -1).join(", ")}, or ${allowedRootsList.at(-1)}`
      : allowedRootsList[0]
  } for this session.`;
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workdir, inputPath, personal);
  } catch {
    throw new Error(allowedRootsMessage);
  }
  const relative = relativePath(workdir, resolved);

  const inAllowedRoot = allowedRoots.some(
    (root) => relative === root || relative.startsWith(`${root}/`),
  );

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
  personal = false,
): string | null {
  const resolved = resolveSandboxToolPath(workdir, inputPath, personal);
  // Personal sessions have no company brain mount; personal-brain/ is a plain writable space, not a
  // gated brain, so nothing is treated as a brain-relative path here.
  if (personal) return null;
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
