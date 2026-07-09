import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDb } from "@opencompany/db/client";
import {
  type MaterializedGoatBrainFile,
  materializeGoatBrainFilesToRoot,
  syncGoatBrainFilesFromRoot,
} from "@opencompany/db/goat-brain-files";
import { goatBrainToolRuns } from "@opencompany/db/goat-schema";
import { createPooledDb } from "@opencompany/db/pool";
import {
  GOAT_BRAIN_ENTITY_TYPES,
  isBuiltInGoatBrainEntityType,
  isValidGoatBrainKind,
} from "@opencompany/goat-brain";
import { getGoatBrainCliSource } from "@opencompany/goat-brain/cli-bundle";
import type {
  GoatBrainCliCommand,
  GoatBrainToolFlagValue,
  GoatBrainToolInput,
  GoatBrainToolOutput,
} from "@/lib/chat-ui";

const GOAT_BRAIN_CHAT_CLI_TIMEOUT_MS = 60_000;
const GOAT_BRAIN_TRACE_SCHEMA_VERSION = "goat.brain.cli-run.v2";
const GOAT_BRAIN_TOOL_HELP =
  'Use goat_brain as { command, flags, stdin? }. For command-specific usage, call { command: "help", flags: { topic: "<command>" } }. Common commands: list, query, get, create, append-evidence, timeline-add, rewrite, alias, link, merge, move, delete, folder, doctor. Use append-evidence to create sourced evidence records linked to a subject. Use includeMerged when you need merged records and includeArchived when you need archived ones.';

const READ_ONLY_GOAT_BRAIN_COMMANDS = new Set<GoatBrainCliCommand>([
  "help",
  "list",
  "get",
  "timeline",
  "query",
  "doctor",
  "folder",
]);
const GOAT_BRAIN_MUTATION_QUEUES = new Map<string, Promise<void>>();

type GoatBrainCliTraceContext = {
  sourceRef: string;
  toolInput: GoatBrainToolInput;
  chatSessionId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  toolCallId?: string;
};

type ResolvedGoatBrainCliArgs = {
  argv: string[];
  display: string;
};

type GoatBrainCliProcessResult = GoatBrainToolOutput & {
  rawStdout: string;
  rawStderr: string;
  timedOut?: boolean;
  aborted?: boolean;
};

export async function runGoatBrainCliForUser(input: {
  brainRef: string;
  userWorkosId: string;
  args?: string;
  argv?: string[];
  gatewayApiKey: string;
  stdin?: string;
  trace?: GoatBrainCliTraceContext;
  signal?: AbortSignal;
}): Promise<GoatBrainToolOutput> {
  const resolved = resolveGoatBrainCliArgs(input);
  if (!resolved) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "goat_brain args are required.",
    };
  }

  const command = normalizeResolvedGoatBrainCommand(resolved.argv[0]);
  if (command && !goatBrainCommandIsReadOnly(command)) {
    // Queue keyed by brain: shared brains serialize mutations across users.
    return enqueueGoatBrainMutation(input.brainRef, () =>
      runResolvedGoatBrainCliForUser(input, resolved, command),
    );
  }
  return runResolvedGoatBrainCliForUser(input, resolved, command);
}

export async function runGoatBrainToolForUser(input: {
  brainRef: string;
  userWorkosId: string;
  toolInput: GoatBrainToolInput;
  gatewayApiKey: string;
  sourceRef: string;
  chatSessionId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
}): Promise<GoatBrainToolOutput> {
  let invocation: { argv: string[]; stdin?: string };
  try {
    invocation = goatBrainToolInvocation(input.toolInput, input.sourceRef);
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: errorMessage(error),
    };
  }
  return runGoatBrainCliForUser({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    argv: invocation.argv,
    gatewayApiKey: input.gatewayApiKey,
    ...(invocation.stdin ? { stdin: invocation.stdin } : {}),
    trace: {
      sourceRef: input.sourceRef,
      toolInput: input.toolInput,
      ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

async function runResolvedGoatBrainCliForUser(
  input: {
    brainRef: string;
    userWorkosId: string;
    gatewayApiKey: string;
    stdin?: string;
    trace?: GoatBrainCliTraceContext;
    signal?: AbortSignal;
  },
  resolved: ResolvedGoatBrainCliArgs,
  command: GoatBrainCliCommand | null,
): Promise<GoatBrainToolOutput> {
  const shouldSync = Boolean(command && !goatBrainCommandIsReadOnly(command));
  const root = await mkdtemp(path.join(os.tmpdir(), "goat-chat-brain-"));
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const traceId = `goat_brain_run_${randomUUID()}`;
  let materialized: MaterializedGoatBrainFile[] = [];
  let processResult: GoatBrainCliProcessResult | null = null;
  let syncResult: { ok: true } | { ok: false; error: string } | null = null;
  let output: GoatBrainToolOutput;

  try {
    materialized = await materializeGoatBrainFilesToRoot({
      brainRef: input.brainRef,
      root,
      cliSource: getGoatBrainCliSource(),
    });
    processResult = await runCliProcess({
      cliPath: path.join(root, "goat-brain.mjs"),
      argv: resolved.argv,
      root,
      gatewayApiKey: input.gatewayApiKey,
      ...(input.stdin ? { stdin: input.stdin } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    output = publicGoatBrainCliOutput(processResult, resolved);
    if (shouldSync && processResult.ok) {
      const synced = await syncGoatBrainFilesFromRootWithTransactionDb({
        brainRef: input.brainRef,
        userWorkosId: input.userWorkosId,
        root,
        baseSnapshot: materialized,
      });
      if (synced.conflicts.length > 0) {
        syncResult = {
          ok: false,
          error: `Brain changed while the tool was running. Retry before writing ${synced.conflicts
            .map((conflict) => conflict.path)
            .join(", ")}.`,
        };
        output = {
          ...output,
          ok: false,
          error: syncResult.error,
        };
      } else {
        syncResult = { ok: true };
      }
    }
  } catch (error) {
    output = {
      ok: false,
      exitCode: processResult?.exitCode ?? null,
      stdout: processResult?.stdout ?? "",
      stderr: processResult?.stderr ?? "",
      command: resolved.display,
      argv: resolved.argv,
      error: errorMessage(error),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const durationMs = Date.now() - startedAtMs;
  output = {
    ...output,
    traceId,
    durationMs,
  };
  await recordGoatBrainToolRun({
    traceId,
    userWorkosId: input.userWorkosId,
    command,
    resolved,
    startedAt,
    durationMs,
    materialized,
    processResult,
    output,
    traceContext: input.trace ?? null,
    syncResult,
  });
  return output;
}

async function syncGoatBrainFilesFromRootWithTransactionDb(input: {
  brainRef: string;
  userWorkosId: string;
  root: string;
  baseSnapshot: MaterializedGoatBrainFile[];
}) {
  const pooled = createPooledDb(undefined, { max: 1 });
  try {
    return await syncGoatBrainFilesFromRoot({
      ...input,
      db: pooled.db,
    });
  } finally {
    await pooled.close();
  }
}

function goatBrainToolInvocation(
  input: GoatBrainToolInput,
  sourceRef: string,
): { argv: string[]; stdin?: string } {
  const rendered = renderGoatBrainToolCommand(input, sourceRef);
  return {
    argv: rendered.argv,
    ...(rendered.stdin ? { stdin: rendered.stdin } : {}),
  };
}

const GOAT_BRAIN_TOOL_COMMAND_FLAGS: Record<GoatBrainCliCommand, readonly string[]> = {
  help: ["topic", "command", "json"],
  create: [
    "folder",
    "id",
    "title",
    "type",
    "kind",
    "truth",
    "truth-stdin",
    "alias",
    "relation",
    "source-ref",
    "source-title",
    "evidence-id",
    "status",
    "json",
  ],
  list: ["folder", "limit", "include-merged", "json"],
  get: ["id", "section", "json"],
  query: [
    "text",
    "folder",
    "since",
    "limit",
    "hops",
    "graph-direction",
    "lexical-only",
    "include-invalid",
    "include-merged",
    "include-archived",
    "json",
  ],
  timeline: ["id", "limit", "since", "json"],
  rewrite: ["id", "truth", "truth-stdin", "json"],
  set: ["id", "title", "type", "status", "json"],
  "timeline-add": [
    "id",
    "at",
    "body",
    "body-stdin",
    "detail",
    "detail-stdin",
    "source-ref",
    "source-title",
    "evidence-id",
    "json",
  ],
  "append-timeline": [
    "id",
    "at",
    "body",
    "body-stdin",
    "detail",
    "detail-stdin",
    "source-ref",
    "source-title",
    "evidence-id",
    "json",
  ],
  "append-evidence": [
    "id",
    "type",
    "folder",
    "at",
    "title",
    "body",
    "body-stdin",
    "detail",
    "detail-stdin",
    "source-ref",
    "source-title",
    "evidence-id",
    "relation",
    "json",
  ],
  alias: ["id", "add", "remove", "json"],
  link: ["id", "to", "as", "remove", "json"],
  merge: ["from", "into", "json"],
  move: ["id", "folder", "json"],
  delete: ["id", "force", "dry-run", "json"],
  folder: ["subcommand", "path", "json"],
  doctor: ["json"],
};

export function renderGoatBrainToolCommand(
  input: GoatBrainToolInput,
  sourceRef: string,
): { argv: string[]; stdin?: string } {
  const allowed = GOAT_BRAIN_TOOL_COMMAND_FLAGS[input.command];
  if (!allowed) throw goatBrainToolInputError(`Unsupported goat_brain command "${input.command}".`);

  const flags = normalizeCliToolFlags(input.flags ?? {});
  applyImplicitStdinFlags(input.command, flags, input.stdin);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(flags).find((name) => !allowedSet.has(name));
  if (unknown) {
    throw goatBrainToolInputError(
      `Unsupported goat_brain flag "--${unknown}" for command "${input.command}".`,
      input.command,
    );
  }

  if (input.command === "delete" && flags.force === true) {
    throw goatBrainToolInputError("The chat tool may only preview deletes. Use dryRun: true.", [
      "delete",
    ]);
  }
  if (input.command === "create") validateCreateFlags(flags, input.stdin);

  const command = cliCommandForToolCommand(input.command);
  const argv: string[] = [command];
  if (input.command === "help") {
    const topic = flags.topic ?? flags.command;
    if (typeof topic === "string" && topic.trim()) argv.push(topic.trim());
    delete flags.topic;
    delete flags.command;
  }
  if (input.command === "folder") {
    const subcommand = flags.subcommand;
    if (typeof subcommand === "string" && subcommand.trim()) argv.push(subcommand.trim());
    delete flags.subcommand;
  }
  if (input.command === "delete") flags["dry-run"] = true;

  injectGoatBrainSourceRef(input.command, flags, sourceRef);
  for (const [name, value] of Object.entries(flags)) {
    if (name === "force") continue;
    appendCliFlag(argv, name, value);
  }
  return { argv, ...(input.stdin ? { stdin: input.stdin } : {}) };
}

function cliCommandForToolCommand(command: GoatBrainCliCommand): string {
  return command;
}

function applyImplicitStdinFlags(
  command: GoatBrainCliCommand,
  flags: Record<string, GoatBrainToolFlagValue>,
  stdin: string | undefined,
) {
  if (!stdin?.trim()) return;
  if (command === "create" && flags.truth === undefined && flags["truth-stdin"] === undefined) {
    flags["truth-stdin"] = true;
    return;
  }
  if (command === "rewrite" && flags.truth === undefined && flags["truth-stdin"] === undefined) {
    flags["truth-stdin"] = true;
    return;
  }
  if (
    (command === "timeline-add" ||
      command === "append-timeline" ||
      command === "append-evidence") &&
    flags.body === undefined &&
    flags["body-stdin"] === undefined
  ) {
    flags["body-stdin"] = true;
  }
}

function normalizeCliToolFlags(input: Record<string, GoatBrainToolFlagValue>) {
  const out: Record<string, GoatBrainToolFlagValue> = {};
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName
      .trim()
      .replace(/_/g, "-")
      .replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
      .replace(/^-+/, "")
      .replace(/-+/g, "-");
    if (name) out[name] = value;
  }
  return out;
}

function injectGoatBrainSourceRef(
  command: GoatBrainCliCommand,
  flags: Record<string, GoatBrainToolFlagValue>,
  sourceRef: string,
) {
  if (
    command === "create" ||
    command === "timeline-add" ||
    command === "append-timeline" ||
    command === "append-evidence"
  ) {
    flags["source-ref"] = sourceRef;
  }
}

function validateCreateFlags(
  flags: Record<string, GoatBrainToolFlagValue>,
  stdin: string | undefined,
) {
  const type = typeof flags.type === "string" ? flags.type.trim() : "";
  if (!type) {
    throw goatBrainToolInputError(
      `goat_brain create requires a type. Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(", ")}.`,
      "create",
    );
  }
  if (!isBuiltInGoatBrainEntityType(type)) {
    throw goatBrainToolInputError(
      `Unsupported Goat Brain entity type "${type}". Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(
        ", ",
      )}.`,
      "create",
    );
  }
  const hasTruth =
    (typeof flags.truth === "string" && flags.truth.trim().length > 0) ||
    (flags["truth-stdin"] === true && Boolean(stdin?.trim()));
  if (!hasTruth) {
    throw goatBrainToolInputError(
      "goat_brain create requires compiled truth via truth or non-empty truthStdin.",
      "create",
    );
  }
  const kind = typeof flags.kind === "string" ? flags.kind.trim() : "";
  if (kind && !isValidGoatBrainKind(kind)) {
    throw goatBrainToolInputError(
      'goat_brain create kind must be "page" or "evidence". Evidence documents live under the "evidence/" folder zone; folders are otherwise free-form.',
      "create",
    );
  }
}

function goatBrainToolInputError(message: string, command?: GoatBrainCliCommand | string[]) {
  const topics =
    typeof command === "string" ? [command] : Array.isArray(command) ? command : undefined;
  const topicHelp = topics?.length
    ? `\n\nRelevant help command: { command: "help", flags: { topic: "${topics[0]}" } }.`
    : "";
  return new Error(`${message}\n\n${GOAT_BRAIN_TOOL_HELP}${topicHelp}`);
}

function appendCliFlag(argv: string[], name: string, value: GoatBrainToolFlagValue) {
  if (typeof value === "boolean") {
    if (value) argv.push(`--${name}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) argv.push(`--${name}`, item);
    return;
  }
  argv.push(`--${name}`, String(value));
}

function resolveGoatBrainCliArgs(input: { args?: string; argv?: string[] }) {
  if (input.argv) {
    const argv = input.argv.map((item) => item.trim()).filter(Boolean);
    return argv.length > 0 ? { argv, display: formatCliDisplay(argv) } : null;
  }
  const rawArgs = input.args?.trim();
  if (!rawArgs) return null;
  const argv = splitCliArgs(rawArgs);
  return argv.length > 0 ? { argv, display: rawArgs } : null;
}

function normalizeResolvedGoatBrainCommand(value: string | undefined): GoatBrainCliCommand | null {
  return isGoatBrainCliCommand(value) ? value : null;
}

function isGoatBrainCliCommand(value: unknown): value is GoatBrainCliCommand {
  return (
    typeof value === "string" &&
    Object.hasOwn(GOAT_BRAIN_TOOL_COMMAND_FLAGS, value as GoatBrainCliCommand)
  );
}

function goatBrainCommandIsReadOnly(command: GoatBrainCliCommand): boolean {
  return READ_ONLY_GOAT_BRAIN_COMMANDS.has(command);
}

async function enqueueGoatBrainMutation<T>(brainRef: string, run: () => Promise<T>): Promise<T> {
  const previous = GOAT_BRAIN_MUTATION_QUEUES.get(brainRef) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = previous.then(run, run);
  const parked = current.then(
    () => new Promise<void>((resolve) => (release = resolve)),
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  GOAT_BRAIN_MUTATION_QUEUES.set(brainRef, parked);
  try {
    return await current;
  } finally {
    release();
    if (GOAT_BRAIN_MUTATION_QUEUES.get(brainRef) === parked) {
      GOAT_BRAIN_MUTATION_QUEUES.delete(brainRef);
    }
  }
}

async function runCliProcess(input: {
  cliPath: string;
  argv: string[];
  root: string;
  gatewayApiKey: string;
  stdin?: string;
  signal?: AbortSignal;
}): Promise<GoatBrainCliProcessResult> {
  const child = spawn(process.execPath, [input.cliPath, ...input.argv, "--report-usage"], {
    env: childBrainCliEnv(input),
    stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (input.stdin && child.stdin) {
    child.stdin.on("error", () => {
      // Child processes may exit before consuming stdin. The exit path below reports the command
      // result; an EPIPE from this write should not crash the parent process.
    });
    child.stdin.end(input.stdin);
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      resolve({
        ok: false,
        exitCode: null,
        stdout: cleanCliStdout(stdout),
        stderr: truncate(stderr, 20_000),
        error: "goat_brain timed out.",
        rawStdout: stdout,
        rawStderr: stderr,
        timedOut: true,
      });
    }, GOAT_BRAIN_CHAT_CLI_TIMEOUT_MS);

    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      resolve({
        ok: false,
        exitCode: null,
        stdout: cleanCliStdout(stdout),
        stderr: truncate(stderr, 20_000),
        error: "goat_brain was aborted.",
        rawStdout: stdout,
        rawStderr: stderr,
        aborted: true,
      });
    };
    input.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      resolve({
        ok: false,
        exitCode: null,
        stdout: cleanCliStdout(stdout),
        stderr: truncate(stderr, 20_000),
        error: error.message,
        rawStdout: stdout,
        rawStderr: stderr,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout: cleanCliStdout(stdout),
        stderr: truncate(stderr, 20_000),
        ...(code === 0 ? {} : { error: "goat_brain failed." }),
        rawStdout: stdout,
        rawStderr: stderr,
      });
    });
  });
}

function childBrainCliEnv(input: { root: string; gatewayApiKey: string }): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "production",
    GOAT_BRAIN_ROOT: input.root,
    VERCEL_AI_GATEWAY_API_KEY: input.gatewayApiKey,
    ...(process.env.GOAT_BRAIN_GATEWAY_BASE_URL
      ? { GOAT_BRAIN_GATEWAY_BASE_URL: process.env.GOAT_BRAIN_GATEWAY_BASE_URL }
      : {}),
    ...(process.env.GOAT_BRAIN_RETRIEVAL_MODEL
      ? { GOAT_BRAIN_RETRIEVAL_MODEL: process.env.GOAT_BRAIN_RETRIEVAL_MODEL }
      : {}),
    ...(process.env.GOAT_BRAIN_EMBEDDING_MODEL
      ? { GOAT_BRAIN_EMBEDDING_MODEL: process.env.GOAT_BRAIN_EMBEDDING_MODEL }
      : {}),
  };
}

function publicGoatBrainCliOutput(
  result: GoatBrainCliProcessResult,
  resolved: ResolvedGoatBrainCliArgs,
): GoatBrainToolOutput {
  const stdout = cleanCliStdout(result.rawStdout);
  const stderr = truncate(result.rawStderr, 20_000);
  const parsed = parseCliJson(stdout);
  const parsedError = readParsedCliError(parsed);
  const error = result.error
    ? !result.ok && stderr.trim()
      ? stderr.trim()
      : (parsedError ?? result.error)
    : undefined;
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stdout,
    stderr,
    command: resolved.display,
    argv: resolved.argv,
    ...(parsed !== null ? { parsed } : {}),
    ...(error ? { error } : {}),
  };
}

function readParsedCliError(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const error = (parsed as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error.trim() : null;
}

async function recordGoatBrainToolRun(input: {
  traceId: string;
  userWorkosId: string;
  command: GoatBrainCliCommand | null;
  resolved: ResolvedGoatBrainCliArgs;
  startedAt: Date;
  durationMs: number;
  materialized: MaterializedGoatBrainFile[];
  processResult: GoatBrainCliProcessResult | null;
  output: GoatBrainToolOutput;
  traceContext: GoatBrainCliTraceContext | null;
  syncResult: { ok: true } | { ok: false; error: string } | null;
}) {
  try {
    await getDb()
      .insert(goatBrainToolRuns)
      .values({
        id: input.traceId,
        userWorkosId: input.userWorkosId,
        chatSessionId: input.traceContext?.chatSessionId ?? null,
        userMessageId: input.traceContext?.userMessageId ?? null,
        assistantMessageId: input.traceContext?.assistantMessageId ?? null,
        toolCallId: input.traceContext?.toolCallId ?? null,
        sourceRef: input.traceContext?.sourceRef ?? null,
        action: input.command,
        ok: input.output.ok,
        exitCode: input.output.exitCode,
        durationMs: input.durationMs,
        tracePath: null,
        trace: {
          schemaVersion: GOAT_BRAIN_TRACE_SCHEMA_VERSION,
          startedAt: input.startedAt.toISOString(),
          argv: input.resolved.argv,
          command: input.resolved.display,
          materialized: input.materialized,
          process: input.processResult
            ? {
                ok: input.processResult.ok,
                exitCode: input.processResult.exitCode,
                timedOut: input.processResult.timedOut === true,
                aborted: input.processResult.aborted === true,
              }
            : null,
          sync: input.syncResult,
          output: {
            ok: input.output.ok,
            exitCode: input.output.exitCode,
            error: input.output.error,
          },
          toolInput: input.traceContext?.toolInput ?? null,
        },
      });
  } catch {
    // Tool trace persistence is best effort; the chat response should still be returned.
  }
}

function cleanCliStdout(stdout: string) {
  return truncate(
    stdout
      .split("\n")
      .filter((line) => !line.startsWith("__GOAT_BRAIN_USAGE__"))
      .join("\n")
      .trim(),
    20_000,
  );
}

function parseCliJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function splitCliArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function formatCliDisplay(argv: readonly string[]) {
  return argv.map(formatCliDisplayArg).join(" ");
}

function formatCliDisplayArg(value: string) {
  if (/^[a-zA-Z0-9._/:=@,+-]+$/.test(value)) return value;
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
