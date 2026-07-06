import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDb } from "@opencompany/db/client";
import {
  type GoatBrainRelation,
  type GoatBrainSource,
  goatBrainDocuments,
  goatBrainDocumentVersions,
  goatBrainFolders,
  goatBrainToolRuns,
} from "@opencompany/db/goat-schema";
import {
  DEFAULT_GOAT_BRAIN_FOLDERS,
  DEFAULT_GOAT_BRAIN_RELATION_TYPE,
  GOAT_BRAIN_MARKDOWN_MIME_TYPE,
  type GoatBrainDocument as GoatBrainContractDocument,
  type GoatBrainDocumentKind,
  type GoatBrainEntityType,
  type GoatBrainEntry,
  type GoatBrainFrontmatter,
  type GoatBrainTimelineEntry,
  goatBrainEntryFromLegacyMarkdown,
  goatBrainFolderFromRelativePath,
  goatBrainIdFromRelativePath,
  goatBrainPayloadRelativePath,
  goatBrainRelativePath,
  goatBrainSidecarRelativePath,
  inferGoatBrainEntityTypeFromFolder,
  isSafeGoatBrainRelativePath,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  normalizeGoatBrainId,
  parseGoatBrainDocument,
  parseGoatBrainSidecar,
  serializeGoatBrainDocument,
  serializeGoatBrainPayload,
  serializeGoatBrainSidecar,
  serializeLegacyGoatBrainEntry,
  validateGoatBrainDocument,
  validateGoatBrainSidecar,
} from "@opencompany/goat-brain";
import { getGoatBrainCliSource } from "@opencompany/goat-brain/cli-bundle";
import { eq, sql } from "drizzle-orm";
import type { GoatBrainToolInput, GoatBrainToolOutput } from "@/lib/chat-ui";

const MAX_GOAT_BRAIN_CHAT_FILE_BYTES = 256 * 1024;
const GOAT_BRAIN_CHAT_CLI_TIMEOUT_MS = 60_000;
const GOAT_BRAIN_TRACE_SCHEMA_VERSION = "goat.brain.cli-run.v1";

type GoatBrainDocumentRow = typeof goatBrainDocuments.$inferSelect;
type LocalBrainFile = {
  relativePath: string;
  content: string;
  sidecarContent?: string;
};

type MaterializedGoatBrainSnapshot = {
  files: MaterializedGoatBrainFile[];
};

type MaterializedGoatBrainFile = {
  documentId: string;
  brainId: string;
  folderPath: string;
  relativePath: string;
  contentHash: string;
};

export async function runGoatBrainCliForUser(input: {
  userWorkosId: string;
  args: string;
  gatewayApiKey: string;
  stdin?: string;
  trace?: GoatBrainCliTraceContext;
  signal?: AbortSignal;
}): Promise<GoatBrainToolOutput> {
  const rawArgs = input.args.trim();
  if (!rawArgs) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "goat_brain args are required.",
    };
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "goat-chat-brain-"));
  const materialized = await materializeGoatBrainToLocalRoot({
    root,
    userWorkosId: input.userWorkosId,
  });
  const traceId = `goat_brain_run_${randomUUID()}`;
  const startedAt = new Date();
  const startedAtMs = Date.now();
  let argv: string[] = [];
  let processResult: GoatBrainCliProcessResult | null = null;
  let syncResult: { ok: true } | { ok: false; error: string } | null = null;
  let output: GoatBrainToolOutput;

  try {
    argv = splitCliArgs(rawArgs);
    processResult = await runCliProcess({
      cliPath: materialized.cliPath,
      argv,
      root,
      gatewayApiKey: input.gatewayApiKey,
      ...(input.stdin ? { stdin: input.stdin } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    try {
      await syncGoatBrainFromLocalRoot({
        root,
        userWorkosId: input.userWorkosId,
        taskId: null,
        baseSnapshot: materialized,
      });
      syncResult = { ok: true };
    } catch (syncError) {
      syncResult = { ok: false, error: errorMessage(syncError) };
      throw syncError;
    }
    output = publicGoatBrainCliOutput(processResult);
  } catch (error) {
    if (!syncResult) {
      try {
        await syncGoatBrainFromLocalRoot({
          root,
          userWorkosId: input.userWorkosId,
          taskId: null,
          baseSnapshot: materialized,
        });
        syncResult = { ok: true };
      } catch (syncError) {
        syncResult = { ok: false, error: errorMessage(syncError) };
      }
    }
    output = {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: errorMessage(error),
    };
  }

  const finishedAt = new Date();
  const durationMs = Date.now() - startedAtMs;
  const traceInput: GoatBrainCliTraceInput = {
    traceId,
    startedAt,
    finishedAt,
    durationMs,
    root,
    userWorkosId: input.userWorkosId,
    rawArgs,
    argv,
    stdin: input.stdin ?? null,
    traceContext: input.trace ?? null,
    timeoutMs: GOAT_BRAIN_CHAT_CLI_TIMEOUT_MS,
    materialized,
    processResult,
    output,
    syncResult,
  };
  const trace = goatBrainCliTrace(traceInput);
  const traceRef = await writeGoatBrainCliTrace(traceId, startedAt, trace);
  await persistGoatBrainToolRunTrace({
    traceId,
    userWorkosId: input.userWorkosId,
    traceContext: input.trace ?? null,
    output,
    durationMs,
    tracePath: traceRef?.tracePath ?? null,
    trace,
    createdAt: startedAt,
  });
  await rm(root, { recursive: true, force: true });
  return {
    ...output,
    durationMs,
    ...(traceRef ? traceRef : {}),
  };
}

export async function runGoatBrainToolForUser(input: {
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
  const invocation = goatBrainToolInvocation(input.toolInput, input.sourceRef);
  return runGoatBrainCliForUser({
    userWorkosId: input.userWorkosId,
    args: invocation.args,
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

function goatBrainToolInvocation(
  input: GoatBrainToolInput,
  sourceRef: string,
): { args: string; stdin?: string } {
  if ("args" in input) return { args: input.args };
  if (input.action === "ingest") {
    return {
      args: [
        "ingest",
        "--text-stdin",
        "--source-ref",
        quoteCliArg(sourceRef),
        ...(input.sourceTitle ? ["--source-title", quoteCliArg(input.sourceTitle)] : []),
        "--json",
      ].join(" "),
      stdin: input.text,
    };
  }
  if (input.action === "query") {
    return {
      args: [
        "query",
        "--text",
        quoteCliArg(input.text),
        ...(input.limit ? ["--limit", String(input.limit)] : []),
        ...(input.hops !== undefined ? ["--hops", String(input.hops)] : []),
      ].join(" "),
    };
  }
  if (input.action === "get") {
    return {
      args: [
        "get",
        quoteCliArg(input.id),
        ...(input.section ? ["--section", input.section] : []),
      ].join(" "),
    };
  }
  throw new Error("Unsupported goat_brain action.");
}

function quoteCliArg(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

type GoatBrainCliTraceContext = {
  sourceRef: string;
  toolInput: GoatBrainToolInput;
  chatSessionId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  toolCallId?: string;
};

type GoatBrainCliProcessResult = GoatBrainToolOutput & {
  rawStdout: string;
  rawStderr: string;
  timedOut?: boolean;
  aborted?: boolean;
};

type GoatBrainCliTraceInput = {
  traceId: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  root: string;
  userWorkosId: string;
  rawArgs: string;
  argv: string[];
  stdin: string | null;
  traceContext: GoatBrainCliTraceContext | null;
  timeoutMs: number;
  materialized: MaterializedGoatBrainSnapshot;
  processResult: GoatBrainCliProcessResult | null;
  output: GoatBrainToolOutput;
  syncResult: { ok: true } | { ok: false; error: string } | null;
};

async function materializeGoatBrainToLocalRoot(input: {
  root: string;
  userWorkosId: string;
}): Promise<MaterializedGoatBrainSnapshot & { cliPath: string }> {
  const documents = await getDb()
    .select()
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, input.userWorkosId));
  const cliPath = path.join(input.root, "goat-brain.mjs");

  await rm(input.root, { recursive: true, force: true });
  await mkdir(input.root, { recursive: true });
  await writeFile(cliPath, getGoatBrainCliSource(), "utf8");

  const files: MaterializedGoatBrainFile[] = [];
  for (const document of documents) {
    const entry = entryFromDocumentRow(document);
    const relativePath = goatBrainPayloadRelativePath(
      entry.folder,
      entry.id,
      entry.kind,
      entry.originalFileName,
    );
    const sidecarPath = goatBrainSidecarRelativePath(entry.folder, entry.id);
    const fullPath = path.join(input.root, relativePath);
    const sidecarFullPath = path.join(input.root, sidecarPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await mkdir(path.dirname(sidecarFullPath), { recursive: true });
    await writeFile(fullPath, serializeGoatBrainPayload(entry), "utf8");
    await writeFile(sidecarFullPath, serializeGoatBrainSidecar(entry), "utf8");
    files.push({
      documentId: document.id,
      brainId: document.brainId,
      folderPath: document.folderPath,
      relativePath,
      contentHash: document.contentHash,
    });
  }

  return { files, cliPath };
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
        stdout: truncate(stdout, 20_000),
        stderr: cleanCliStderr(stderr),
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
        stdout: truncate(stdout, 20_000),
        stderr: cleanCliStderr(stderr),
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
        stdout: truncate(stdout, 20_000),
        stderr: cleanCliStderr(stderr),
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
        ok: goatBrainCliSucceeded(code, stdout),
        exitCode: code,
        stdout: truncate(stdout, 20_000),
        stderr: cleanCliStderr(stderr),
        rawStdout: stdout,
        rawStderr: stderr,
      });
    });
  });
}

function goatBrainCliSucceeded(exitCode: number | null, stdout: string): boolean {
  if (exitCode === 0) return true;
  return parseGoatBrainCliJson(stdout)?.ok === true;
}

function parseGoatBrainCliJson(stdout: string): { ok?: unknown } | null {
  try {
    const parsed = JSON.parse(stdout.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { ok?: unknown })
      : null;
  } catch {
    return null;
  }
}

function publicGoatBrainCliOutput(result: GoatBrainCliProcessResult): GoatBrainToolOutput {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function writeGoatBrainCliTrace(
  traceId: string,
  startedAt: Date,
  trace: Record<string, unknown>,
): Promise<{ traceId: string; tracePath: string } | null> {
  if (!shouldWriteLocalGoatBrainTrace()) return null;

  try {
    const dir = await goatBrainTraceDir();
    await mkdir(dir, { recursive: true });
    const tracePath = path.join(
      dir,
      `${startedAt.toISOString().replace(/[:.]/g, "-")}-${traceId}.json`,
    );
    await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
    return { traceId, tracePath };
  } catch {
    return null;
  }
}

async function persistGoatBrainToolRunTrace(input: {
  traceId: string;
  userWorkosId: string;
  traceContext: GoatBrainCliTraceContext | null;
  output: GoatBrainToolOutput;
  durationMs: number;
  tracePath: string | null;
  trace: Record<string, unknown>;
  createdAt: Date;
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
        action: goatBrainToolAction(input.traceContext?.toolInput ?? null),
        ok: input.output.ok,
        exitCode: input.output.exitCode,
        durationMs: input.durationMs,
        tracePath: input.tracePath,
        trace: input.trace,
        createdAt: input.createdAt,
      });
  } catch (error) {
    console.warn("Failed to persist goat brain tool trace.", error);
  }
}

function goatBrainToolAction(input: GoatBrainToolInput | null) {
  if (!input) return null;
  if ("args" in input) return "raw";
  return input.action;
}

function goatBrainCliTrace(input: GoatBrainCliTraceInput): Record<string, unknown> {
  return {
    schemaVersion: GOAT_BRAIN_TRACE_SCHEMA_VERSION,
    traceId: input.traceId,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.durationMs,
    timeoutMs: input.timeoutMs,
    userWorkosId: input.userWorkosId,
    sourceRef: input.traceContext?.sourceRef ?? null,
    chatSessionId: input.traceContext?.chatSessionId ?? null,
    userMessageId: input.traceContext?.userMessageId ?? null,
    assistantMessageId: input.traceContext?.assistantMessageId ?? null,
    toolCallId: input.traceContext?.toolCallId ?? null,
    toolInput: input.traceContext?.toolInput ?? null,
    command: {
      rawArgs: input.rawArgs,
      argv: input.argv,
      stdin: input.stdin,
    },
    materialized: {
      tempRoot: input.root,
      documentCount: input.materialized.files.length,
      documents: input.materialized.files.map((file) => ({
        brainId: file.brainId,
        folderPath: file.folderPath,
        relativePath: file.relativePath,
        contentHash: file.contentHash,
      })),
    },
    process: input.processResult
      ? {
          ok: input.processResult.ok,
          exitCode: input.processResult.exitCode,
          error: input.processResult.error ?? null,
          timedOut: Boolean(input.processResult.timedOut),
          aborted: Boolean(input.processResult.aborted),
          stdout: input.processResult.rawStdout,
          stderr: input.processResult.rawStderr,
          cleanStderr: input.processResult.stderr,
        }
      : null,
    sync: input.syncResult,
    output: input.output,
    env: {
      goatBrainGatewayBaseUrl: process.env.GOAT_BRAIN_GATEWAY_BASE_URL ?? null,
      goatBrainIngestModel: process.env.GOAT_BRAIN_INGEST_MODEL ?? null,
      goatBrainRetrievalModel: process.env.GOAT_BRAIN_RETRIEVAL_MODEL ?? null,
      goatBrainEmbeddingModel: process.env.GOAT_BRAIN_EMBEDDING_MODEL ?? null,
    },
  };
}

function shouldWriteLocalGoatBrainTrace() {
  return process.env.NODE_ENV !== "production";
}

async function goatBrainTraceDir() {
  const root = await findWorkspaceRoot(process.cwd());
  return path.join(root, ".context", "goat-brain-runs");
}

async function findWorkspaceRoot(start: string) {
  let current = path.resolve(start);
  while (true) {
    try {
      const turbo = await stat(path.join(current, "turbo.json"));
      if (turbo.isFile()) return current;
    } catch {
      // Walk upward until the monorepo root is found.
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function childBrainCliEnv(input: { root: string; gatewayApiKey: string }): NodeJS.ProcessEnv {
  return {
    GOAT_BRAIN_ROOT: input.root,
    VERCEL_AI_GATEWAY_API_KEY: input.gatewayApiKey,
    NODE_ENV: process.env.NODE_ENV ?? "production",
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.GOAT_BRAIN_GATEWAY_BASE_URL
      ? { GOAT_BRAIN_GATEWAY_BASE_URL: process.env.GOAT_BRAIN_GATEWAY_BASE_URL }
      : {}),
    ...(process.env.GOAT_BRAIN_INGEST_MODEL
      ? { GOAT_BRAIN_INGEST_MODEL: process.env.GOAT_BRAIN_INGEST_MODEL }
      : {}),
    ...(process.env.GOAT_BRAIN_RETRIEVAL_MODEL
      ? { GOAT_BRAIN_RETRIEVAL_MODEL: process.env.GOAT_BRAIN_RETRIEVAL_MODEL }
      : {}),
    ...(process.env.GOAT_BRAIN_EMBEDDING_MODEL
      ? { GOAT_BRAIN_EMBEDDING_MODEL: process.env.GOAT_BRAIN_EMBEDDING_MODEL }
      : {}),
  };
}

async function syncGoatBrainFromLocalRoot(input: {
  root: string;
  userWorkosId: string;
  taskId: string | null;
  baseSnapshot: MaterializedGoatBrainSnapshot;
}) {
  const files = await readLocalBrainFiles(input.root);
  const baseByPath = new Map(input.baseSnapshot.files.map((file) => [file.relativePath, file]));
  const baseByBrainId = new Map(input.baseSnapshot.files.map((file) => [file.brainId, file]));
  const currentRows = await getDb()
    .select()
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, input.userWorkosId));
  const currentByDocumentId = new Map(currentRows.map((row) => [row.id, row]));
  const currentByBrainId = new Map(currentRows.map((row) => [row.brainId, row]));
  const seenBrainIds = new Set<string>();
  const seenBasePaths = new Set<string>();

  for (const file of files) {
    const pathId = goatBrainIdFromRelativePath(file.relativePath);
    const baseForPath =
      baseByPath.get(file.relativePath) ?? (pathId ? baseByBrainId.get(pathId) : undefined);
    const validated = validateLocalBrainFile(file);
    if (!validated.ok) {
      if (baseForPath) {
        seenBasePaths.add(baseForPath.relativePath);
        seenBrainIds.add(baseForPath.brainId);
      }
      continue;
    }
    const base = baseForPath ?? baseByBrainId.get(validated.brainId);
    if (base) {
      seenBasePaths.add(base.relativePath);
      seenBrainIds.add(base.brainId);
    }
    if (base?.contentHash === validated.contentHash) continue;

    const current = base
      ? currentByDocumentId.get(base.documentId)
      : currentByBrainId.get(validated.brainId);
    const collidingCurrent = base && current ? currentByBrainId.get(validated.brainId) : undefined;
    if (
      base &&
      current?.contentHash === base.contentHash &&
      collidingCurrent &&
      collidingCurrent.id !== current.id
    ) {
      await insertConflictBrainDocument({
        userWorkosId: input.userWorkosId,
        taskId: input.taskId,
        validated,
      });
      continue;
    }

    if (base && current?.contentHash === base.contentHash) {
      await updateBrainDocument({
        userWorkosId: input.userWorkosId,
        taskId: input.taskId,
        current,
        validated,
      });
      continue;
    }

    if (!base && !current) {
      await insertBrainDocument({
        userWorkosId: input.userWorkosId,
        validated,
      });
      continue;
    }

    await insertConflictBrainDocument({
      userWorkosId: input.userWorkosId,
      taskId: input.taskId,
      validated,
    });
  }

  for (const base of input.baseSnapshot.files) {
    if (seenBasePaths.has(base.relativePath) || seenBrainIds.has(base.brainId)) continue;
    const current = currentByDocumentId.get(base.documentId);
    if (!current || current.contentHash !== base.contentHash) continue;
    await deleteBrainDocument({
      userWorkosId: input.userWorkosId,
      taskId: input.taskId,
      current,
    });
  }
}

async function readLocalBrainFiles(root: string) {
  const relativePaths = await walkLocalMarkdown(root, "");
  const files: LocalBrainFile[] = [];
  for (const relativePath of relativePaths) {
    if (!isSafeGoatBrainRelativePath(relativePath)) continue;
    const content = await readFile(path.join(root, relativePath), "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_GOAT_BRAIN_CHAT_FILE_BYTES) continue;
    const sidecarContent = await readLocalSidecar(root, relativePath);
    files.push({ relativePath, content, ...(sidecarContent ? { sidecarContent } : {}) });
  }
  return files;
}

async function readLocalSidecar(root: string, relativePath: string) {
  const id = goatBrainIdFromRelativePath(relativePath);
  const folder = goatBrainFolderFromRelativePath(relativePath);
  if (!id || !folder) return null;
  try {
    return await readFile(path.join(root, goatBrainSidecarRelativePath(folder, id)), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function walkLocalMarkdown(root: string, relDir: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(path.join(root, relDir), { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const found: string[] = [];
  for (const entry of entries) {
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".brain") continue;
      found.push(...(await walkLocalMarkdown(root, childRel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(childRel);
    }
  }
  return found.sort();
}

function validateLocalBrainFile(file: LocalBrainFile):
  | {
      ok: true;
      brainId: string;
      folderPath: string;
      title: string;
      content: string;
      body: string;
      timeline: GoatBrainTimelineEntry[];
      kind: GoatBrainDocumentKind;
      mimeType: string;
      originalFileName: string | null;
      assetStorageKey: string | null;
      contentHash: string;
      sizeBytes: number;
      relations: GoatBrainRelation[];
      sources: GoatBrainSource[];
      entityType: GoatBrainEntityType;
      aliases: string[];
      document: GoatBrainContractDocument;
    }
  | { ok: false } {
  const pathId = goatBrainIdFromRelativePath(file.relativePath);
  const pathFolder = goatBrainFolderFromRelativePath(file.relativePath);
  if (!pathId || !pathFolder) return { ok: false };

  if (file.sidecarContent) {
    const sidecarValidation = validateGoatBrainSidecar({
      sidecar: parseGoatBrainSidecar(file.sidecarContent),
      payloadContent: file.content,
      payloadRelativePath: file.relativePath,
    });
    if (!sidecarValidation.ok) return { ok: false };
    const entry = sidecarValidation.entry;
    const content = serializeLegacyGoatBrainEntry(entry);
    const parsed = parseGoatBrainDocument(content);
    const validation = validateGoatBrainDocument(parsed, pathId, content);
    if (!validation.ok || entry.folder !== pathFolder || entry.id !== pathId) return { ok: false };
    const sizeBytes = Buffer.byteLength(content, "utf8");
    return {
      ok: true,
      brainId: entry.id,
      folderPath: entry.folder,
      title: entry.title,
      content,
      body: entry.body,
      timeline: entry.kind === "markdown" ? entry.timeline : [],
      kind: entry.kind,
      mimeType: entry.mimeType,
      originalFileName: entry.originalFileName ?? null,
      assetStorageKey: entry.assetStorageKey ?? null,
      contentHash: hashContent(content),
      sizeBytes,
      relations: entry.relations,
      sources: entry.sources,
      entityType: entry.type,
      aliases: entry.aliases,
      document: {
        frontmatter: parsed.frontmatter as GoatBrainFrontmatter,
        title: entry.title,
        compiledTruth: entry.body,
        timeline: entry.kind === "markdown" ? entry.timeline : [],
      },
    };
  }

  const parsed = parseGoatBrainDocument(file.content);
  const validation = validateGoatBrainDocument(parsed, pathId, file.content);
  if (!validation.ok) return { ok: false };
  if (parsed.frontmatter.folder !== pathFolder) return { ok: false };
  const frontmatter = parsed.frontmatter as GoatBrainFrontmatter;
  if (!isValidGoatBrainId(frontmatter.id) || !isValidGoatBrainFolder(frontmatter.folder)) {
    return { ok: false };
  }

  const sizeBytes = Buffer.byteLength(file.content, "utf8");
  const title = (frontmatter.title ?? parsed.title).trim() || frontmatter.id;
  const entry = goatBrainEntryFromLegacyMarkdown(file.content);
  return {
    ok: true,
    brainId: frontmatter.id,
    folderPath: frontmatter.folder,
    title,
    content: file.content,
    body: entry.body,
    timeline: entry.timeline,
    kind: entry.kind,
    mimeType: entry.mimeType,
    originalFileName: entry.originalFileName ?? null,
    assetStorageKey: entry.assetStorageKey ?? null,
    contentHash: hashContent(file.content),
    sizeBytes,
    relations: frontmatter.relations.map((relation) => ({
      type: relation.type,
      to: relation.to,
    })),
    sources: (frontmatter.sources ?? []).map((source) => ({
      ref: source.ref,
      ...(source.title ? { title: source.title } : {}),
      ...(source.capturedAt ? { capturedAt: source.capturedAt } : {}),
    })),
    entityType: entry.type,
    aliases: entry.aliases,
    document: {
      frontmatter,
      title,
      compiledTruth: parsed.compiledTruth,
      timeline: parsed.timeline,
    },
  };
}

async function updateBrainDocument(input: {
  userWorkosId: string;
  taskId: string | null;
  current: GoatBrainDocumentRow | undefined;
  validated: ValidatedLocalBrainFile;
}) {
  if (!input.current) {
    await insertBrainDocument(input);
    return;
  }
  const current = input.current;

  await ensureBrainFolder(input.userWorkosId, input.validated.folderPath);
  const now = new Date();
  await getDb().execute(sql`
    WITH existing AS (
      SELECT *
      FROM goat.brain_documents
      WHERE id = ${current.id}
        AND user_workos_id = ${input.userWorkosId}
      LIMIT 1
    ),
    version AS (
      INSERT INTO goat.brain_document_versions (
        user_workos_id,
        document_id,
        task_id,
        brain_id,
        folder_path,
        content,
        content_hash,
        size_bytes,
        operation,
        created_at
      )
      SELECT
        existing.user_workos_id,
        existing.id,
        ${input.taskId ?? null},
        existing.brain_id,
        existing.folder_path,
        existing.content,
        existing.content_hash,
        existing.size_bytes,
        'overwrite',
        ${now}
      FROM existing
      RETURNING document_id
    )
    UPDATE goat.brain_documents AS document
    SET brain_id = ${input.validated.brainId},
        folder_path = ${input.validated.folderPath},
        title = ${input.validated.title},
        content = ${input.validated.content},
        body = ${input.validated.body},
        timeline = ${JSON.stringify(input.validated.timeline)}::jsonb,
        kind = ${input.validated.kind},
        mime_type = ${input.validated.mimeType},
        original_file_name = ${input.validated.originalFileName},
        asset_storage_key = ${input.validated.assetStorageKey},
        relations = ${JSON.stringify(input.validated.relations)}::jsonb,
        sources = ${JSON.stringify(input.validated.sources)}::jsonb,
        entity_type = ${input.validated.entityType},
        aliases = ${JSON.stringify(input.validated.aliases)}::jsonb,
        content_hash = ${input.validated.contentHash},
        size_bytes = ${input.validated.sizeBytes},
        updated_at = ${now}
    WHERE document.id = ${current.id}
      AND document.user_workos_id = ${input.userWorkosId}
      AND EXISTS (SELECT 1 FROM version)
  `);
}

async function insertBrainDocument(input: {
  userWorkosId: string;
  validated: ValidatedLocalBrainFile;
}) {
  await ensureBrainFolder(input.userWorkosId, input.validated.folderPath);
  const now = new Date();
  await getDb()
    .insert(goatBrainDocuments)
    .values({
      id: `goat_brain_doc_${randomUUID()}`,
      userWorkosId: input.userWorkosId,
      brainId: input.validated.brainId,
      folderPath: input.validated.folderPath,
      title: input.validated.title,
      content: input.validated.content,
      body: input.validated.body,
      timeline: input.validated.timeline,
      kind: input.validated.kind,
      mimeType: input.validated.mimeType,
      originalFileName: input.validated.originalFileName,
      assetStorageKey: input.validated.assetStorageKey,
      relations: input.validated.relations,
      sources: input.validated.sources,
      entityType: input.validated.entityType,
      aliases: input.validated.aliases,
      contentHash: input.validated.contentHash,
      sizeBytes: input.validated.sizeBytes,
      createdAt: now,
      updatedAt: now,
    });
}

async function insertConflictBrainDocument(input: {
  userWorkosId: string;
  taskId: string | null;
  validated: ValidatedLocalBrainFile;
}) {
  const conflictId = await nextConflictBrainId(input.userWorkosId, input.validated.brainId);
  const conflictDocument: GoatBrainContractDocument = {
    ...input.validated.document,
    frontmatter: {
      ...input.validated.document.frontmatter,
      id: conflictId,
      title: `${input.validated.title} conflict`,
      updatedAt: new Date().toISOString(),
      relations: [
        ...input.validated.document.frontmatter.relations,
        { type: "conflicts_with", to: input.validated.brainId },
      ],
    },
    title: `${input.validated.title} conflict`,
  };
  const content = serializeGoatBrainDocument(conflictDocument);
  const validated = validateLocalBrainFile({
    relativePath: goatBrainRelativePath(conflictDocument.frontmatter.folder, conflictId),
    content,
  });
  if (!validated.ok) return;
  await insertBrainDocument({
    userWorkosId: input.userWorkosId,
    validated,
  });
  await getDb()
    .insert(goatBrainDocumentVersions)
    .values({
      userWorkosId: input.userWorkosId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      brainId: input.validated.brainId,
      folderPath: input.validated.folderPath,
      content: input.validated.content,
      contentHash: input.validated.contentHash,
      sizeBytes: input.validated.sizeBytes,
      operation: "overwrite",
      createdAt: new Date(),
    });
}

async function deleteBrainDocument(input: {
  userWorkosId: string;
  taskId: string | null;
  current: GoatBrainDocumentRow;
}) {
  const now = new Date();
  await getDb().execute(sql`
    WITH existing AS (
      SELECT *
      FROM goat.brain_documents
      WHERE id = ${input.current.id}
        AND user_workos_id = ${input.userWorkosId}
      LIMIT 1
    ),
    version AS (
      INSERT INTO goat.brain_document_versions (
        user_workos_id,
        document_id,
        task_id,
        brain_id,
        folder_path,
        content,
        content_hash,
        size_bytes,
        operation,
        created_at
      )
      SELECT
        existing.user_workos_id,
        existing.id,
        ${input.taskId ?? null},
        existing.brain_id,
        existing.folder_path,
        existing.content,
        existing.content_hash,
        existing.size_bytes,
        'delete',
        ${now}
      FROM existing
      RETURNING document_id
    )
    DELETE FROM goat.brain_documents AS document
    WHERE document.id = ${input.current.id}
      AND document.user_workos_id = ${input.userWorkosId}
      AND EXISTS (SELECT 1 FROM version)
  `);
}

async function ensureBrainFolder(userWorkosId: string, folderPath: string) {
  if (!isValidGoatBrainFolder(folderPath)) return;
  const now = new Date();
  const source = (DEFAULT_GOAT_BRAIN_FOLDERS as readonly string[]).includes(folderPath)
    ? "system"
    : "custom";
  await getDb()
    .insert(goatBrainFolders)
    .values({
      id: `goat_brain_folder_${randomUUID()}`,
      userWorkosId,
      path: folderPath,
      source,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [goatBrainFolders.userWorkosId, goatBrainFolders.path],
      set: { source, updatedAt: now },
    });
}

async function nextConflictBrainId(userWorkosId: string, brainId: string) {
  const base = normalizeGoatBrainId(`${brainId}-conflict`) || "conflict";
  const existing = await getDb()
    .select({ brainId: goatBrainDocuments.brainId })
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.userWorkosId, userWorkosId));
  const taken = new Set(existing.map((document) => document.brainId));
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = normalizeGoatBrainId(`${base}-${suffix}`);
    if (candidate && isValidGoatBrainId(candidate) && !taken.has(candidate)) return candidate;
  }
  return normalizeGoatBrainId(`conflict-${randomUUID().slice(0, 8)}`) || "conflict";
}

function splitCliArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of value) {
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
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote) throw new Error("Invalid goat_brain args quoting.");
  if (current) args.push(current);
  return args;
}

function cleanCliStderr(stderr: string) {
  return truncate(
    stderr
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("__GOAT_BRAIN_USAGE__"))
      .join("\n")
      .trim(),
    4_000,
  );
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function entryFromDocumentRow(row: GoatBrainDocumentRow): GoatBrainEntry {
  const legacyEntry = safeLegacyEntry(row.content);
  const kind = isGoatBrainDocumentKind(row.kind) ? row.kind : "markdown";
  return {
    id: row.brainId,
    folder: row.folderPath,
    title: row.title?.trim() || legacyEntry?.title || row.brainId,
    kind,
    mimeType: row.mimeType?.trim() || mimeTypeForKind(kind),
    body: row.body || legacyEntry?.body || "",
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    relations: normalizeEntryRelations(row.relations ?? legacyEntry?.relations ?? []),
    sources: row.sources ?? legacyEntry?.sources ?? [],
    type:
      normalizeEntityType(row.entityType) ??
      legacyEntry?.type ??
      inferGoatBrainEntityTypeFromFolder(row.folderPath),
    aliases: normalizeStringArray(row.aliases, legacyEntry?.aliases ?? []),
    tags: legacyEntry?.tags ?? [],
    timeline:
      kind === "markdown" ? normalizeTimeline(row.timeline, legacyEntry?.timeline ?? []) : [],
    ...(row.originalFileName ? { originalFileName: row.originalFileName } : {}),
    ...(row.assetStorageKey ? { assetStorageKey: row.assetStorageKey } : {}),
  };
}

function safeLegacyEntry(content: string): GoatBrainEntry | null {
  try {
    return goatBrainEntryFromLegacyMarkdown(content);
  } catch {
    return null;
  }
}

function normalizeTimeline(value: unknown, fallback: GoatBrainTimelineEntry[]) {
  if (!Array.isArray(value)) return fallback;
  return value.flatMap((entry): GoatBrainTimelineEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.at !== "string" || typeof record.body !== "string") return [];
    return [{ at: record.at, body: record.body }];
  });
}

function normalizeEntryRelations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((relation): GoatBrainEntry["relations"] => {
    if (!relation || typeof relation !== "object") return [];
    const record = relation as Record<string, unknown>;
    if (typeof record.to !== "string") return [];
    return [
      {
        type: typeof record.type === "string" ? record.type : DEFAULT_GOAT_BRAIN_RELATION_TYPE,
        to: record.to,
      },
    ];
  });
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeEntityType(value: unknown): GoatBrainEntityType | null {
  if (
    value === "person" ||
    value === "company" ||
    value === "project" ||
    value === "meeting" ||
    value === "decision" ||
    value === "research" ||
    value === "source" ||
    value === "note"
  ) {
    return value;
  }
  return null;
}

function isGoatBrainDocumentKind(value: unknown): value is GoatBrainDocumentKind {
  return value === "markdown" || value === "pdf" || value === "docx";
}

function mimeTypeForKind(kind: GoatBrainDocumentKind) {
  if (kind === "pdf") return "application/pdf";
  if (kind === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return GOAT_BRAIN_MARKDOWN_MIME_TYPE;
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type ValidatedLocalBrainFile = Extract<ReturnType<typeof validateLocalBrainFile>, { ok: true }>;
