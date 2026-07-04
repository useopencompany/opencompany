import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDb } from "@opencompany/db/client";
import {
  type GoatBrainRelation,
  type GoatBrainSource,
  goatBrainDocuments,
  goatBrainDocumentVersions,
  goatBrainFolders,
} from "@opencompany/db/goat-schema";
import {
  DEFAULT_GOAT_BRAIN_FOLDERS,
  type GoatBrainDocument as GoatBrainContractDocument,
  type GoatBrainFrontmatter,
  goatBrainFolderFromRelativePath,
  goatBrainIdFromRelativePath,
  goatBrainRelativePath,
  isSafeGoatBrainRelativePath,
  isValidGoatBrainFolder,
  isValidGoatBrainId,
  normalizeGoatBrainId,
  parseGoatBrainDocument,
  serializeGoatBrainDocument,
  validateGoatBrainDocument,
} from "@opencompany/goat-brain";
import { getGoatBrainCliSource } from "@opencompany/goat-brain/cli-bundle";
import { eq, sql } from "drizzle-orm";
import type { GoatBrainToolOutput } from "@/lib/chat-ui";

const MAX_GOAT_BRAIN_CHAT_FILE_BYTES = 256 * 1024;
const GOAT_BRAIN_CHAT_CLI_TIMEOUT_MS = 20_000;

type GoatBrainDocumentRow = typeof goatBrainDocuments.$inferSelect;

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

  try {
    const argv = splitCliArgs(rawArgs);
    const result = await runCliProcess({
      cliPath: materialized.cliPath,
      argv,
      root,
      gatewayApiKey: input.gatewayApiKey,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await syncGoatBrainFromLocalRoot({
      root,
      userWorkosId: input.userWorkosId,
      taskId: null,
      baseSnapshot: materialized,
    });
    return result;
  } catch (error) {
    await syncGoatBrainFromLocalRoot({
      root,
      userWorkosId: input.userWorkosId,
      taskId: null,
      baseSnapshot: materialized,
    });
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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
    const relativePath = goatBrainRelativePath(document.folderPath, document.brainId);
    const fullPath = path.join(input.root, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, document.content, "utf8");
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
  signal?: AbortSignal;
}): Promise<GoatBrainToolOutput> {
  const child = spawn(process.execPath, [input.cliPath, ...input.argv, "--report-usage"], {
    env: childBrainCliEnv(input),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const append = (current: string, chunk: Buffer) =>
    truncate(`${current}${chunk.toString("utf8")}`, 24_000);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
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
        stdout: truncate(stdout, 20_000),
        stderr: cleanCliStderr(stderr),
      });
    });
  });
}

function childBrainCliEnv(input: { root: string; gatewayApiKey: string }): NodeJS.ProcessEnv {
  return {
    GOAT_BRAIN_ROOT: input.root,
    VERCEL_AI_GATEWAY_API_KEY: input.gatewayApiKey,
    NODE_ENV: process.env.NODE_ENV ?? "production",
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
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
    const validated = validateLocalBrainFile(file);
    if (!validated.ok) continue;
    const base = baseByPath.get(file.relativePath) ?? baseByBrainId.get(validated.brainId);
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
  const files: { relativePath: string; content: string }[] = [];
  for (const relativePath of relativePaths) {
    if (!isSafeGoatBrainRelativePath(relativePath)) continue;
    const content = await readFile(path.join(root, relativePath), "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_GOAT_BRAIN_CHAT_FILE_BYTES) continue;
    files.push({ relativePath, content });
  }
  return files;
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
      found.push(...(await walkLocalMarkdown(root, childRel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(childRel);
    }
  }
  return found.sort();
}

function validateLocalBrainFile(file: { relativePath: string; content: string }):
  | {
      ok: true;
      brainId: string;
      folderPath: string;
      title: string;
      content: string;
      contentHash: string;
      sizeBytes: number;
      related: GoatBrainRelation[];
      sources: GoatBrainSource[];
      document: GoatBrainContractDocument;
    }
  | { ok: false } {
  const pathId = goatBrainIdFromRelativePath(file.relativePath);
  const pathFolder = goatBrainFolderFromRelativePath(file.relativePath);
  if (!pathId || !pathFolder) return { ok: false };

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
  return {
    ok: true,
    brainId: frontmatter.id,
    folderPath: frontmatter.folder,
    title,
    content: file.content,
    contentHash: hashContent(file.content),
    sizeBytes,
    related: frontmatter.related.map((relation) => ({
      ...(relation.type ? { type: relation.type } : {}),
      target: relation.target,
    })),
    sources: (frontmatter.sources ?? []).map((source) => ({
      ref: source.ref,
      ...(source.title ? { title: source.title } : {}),
      ...(source.capturedAt ? { capturedAt: source.capturedAt } : {}),
    })),
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
        related = ${JSON.stringify(input.validated.related)}::jsonb,
        sources = ${JSON.stringify(input.validated.sources)}::jsonb,
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
      related: input.validated.related,
      sources: input.validated.sources,
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
      related: [
        ...input.validated.document.frontmatter.related,
        { type: "conflicts_with", target: input.validated.brainId },
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

type ValidatedLocalBrainFile = Extract<ReturnType<typeof validateLocalBrainFile>, { ok: true }>;
