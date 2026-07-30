import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { shellQuote } from "@opencompany/agent-runtime";
import {
  type MaterializedGoatBrainFile as DbMaterializedGoatBrainFile,
  GOAT_BRAIN_FILE_MIME_TYPE,
  type GoatBrainSyncFile,
  goatBrainFilePathFor,
  listGoatBrainFiles,
  listGoatBrainFolderRows,
  materializeGoatBrainFilesToRoot,
  readGoatBrainFilesFromRoot,
  syncGoatBrainFiles,
  upsertGoatBrainFile,
} from "@opencompany/db/goat-brain-files";
import { getDefaultGoatBrainForUser } from "@opencompany/db/goat-workspaces";
import {
  formatGoatBrainEvidenceLink,
  GOAT_BRAIN_FOLDER_MANIFEST_PATH,
  type GoatBrainDocument,
  goatBrainTimelineEntryFromParts,
  normalizeEvidenceId,
  normalizeGoatBrainId,
  parseGoatBrainFolderManifest,
  serializeGoatBrainDocument,
  serializeGoatBrainFolderManifest,
} from "@opencompany/goat-brain";
import { getGoatBrainCliSource } from "@opencompany/goat-brain/cli-bundle";
import { getDb } from "./db";
import type { SandboxHandle } from "./sandbox";

export const GOAT_BRAIN_ROOT = "/home/user/goat-brain";
export const GOAT_BRAIN_CLI_PATH = "/tmp/goat-brain.mjs";
export const MAX_GOAT_BRAIN_MARKDOWN_DOCUMENT_BYTES = 256 * 1024;
export const MAX_GOAT_BRAIN_SANDBOX_FILE_BYTES = MAX_GOAT_BRAIN_MARKDOWN_DOCUMENT_BYTES;
export const GOAT_BRAIN_REPORT_FOLDER = "research";

export type MaterializedGoatBrainSnapshot = {
  files: MaterializedGoatBrainFile[];
};

export type MaterializedGoatBrainFile = {
  documentId: string;
  brainId: string;
  folderPath: string;
  relativePath: string;
  contentHash: string;
};

export type GoatBrainMarkdownReportArtifact = {
  type: "brain_markdown_report";
  title: string;
  documentId: string;
  brainId: string;
  folderPath: string;
  brainPath: string;
  url: string;
  mimeType: typeof GOAT_BRAIN_FILE_MIME_TYPE;
};

export async function createGoatBrainMarkdownReportForTask(input: {
  userWorkosId: string;
  taskId: string;
  taskTurnId?: string | undefined;
  title: string;
  markdown: string;
}): Promise<GoatBrainMarkdownReportArtifact> {
  const body = input.markdown.trim();
  if (!body) throw new Error("Cannot save an empty Goat research report.");
  if (Buffer.byteLength(body, "utf8") > MAX_GOAT_BRAIN_MARKDOWN_DOCUMENT_BYTES) {
    throw new Error("Goat research report is too large to save to the Brain.");
  }

  const title = firstMarkdownHeading(body) || input.title.trim() || "Research report";
  const brainRef = await resolveGoatBrainRefForUser(input.userWorkosId);
  const existingFiles = await listGoatBrainFiles(
    { brainRef },
    {
      includeInvalid: true,
      db: getDb(),
    },
  );
  const taskTurnSourceRef = input.taskTurnId ? `goat-task-turn:${input.taskTurnId}` : null;
  const existingReport = taskTurnSourceRef
    ? existingFiles.find((file) => file.sources.some((source) => source.ref === taskTurnSourceRef))
    : null;
  if (existingReport) {
    return {
      type: "brain_markdown_report",
      title: existingReport.title || title,
      documentId: existingReport.id,
      brainId: existingReport.brainId,
      folderPath: existingReport.folderPath,
      brainPath: goatBrainFilePathFor(existingReport.folderPath, existingReport.brainId),
      url: brainDocumentUrl(existingReport.folderPath, existingReport.brainId),
      mimeType: GOAT_BRAIN_FILE_MIME_TYPE,
    };
  }

  const brainId = nextAvailableBrainId(existingFiles, title);
  const folderPath = GOAT_BRAIN_REPORT_FOLDER;
  const now = new Date().toISOString();
  const evidenceId = normalizeEvidenceId(`ev-created-from-${input.taskId}`) ?? "ev-task-created";
  const citedBody = `${body}\n\nEvidence: ${formatGoatBrainEvidenceLink(evidenceId, `Task ${input.taskId}`)}`;
  const doc: GoatBrainDocument = {
    frontmatter: {
      id: brainId,
      folder: folderPath,
      kind: "page",
      type: "analysis",
      status: "active",
      title,
      createdAt: now,
      updatedAt: now,
      relations: [],
      sources: [
        {
          ref: `goat-task:${input.taskId}`,
          title: `Task ${input.taskId}`,
          capturedAt: now,
        },
        ...(taskTurnSourceRef
          ? [
              {
                ref: taskTurnSourceRef,
                title: `Task turn ${input.taskTurnId}`,
                capturedAt: now,
              },
            ]
          : []),
      ],
    },
    title,
    compiledTruth: citedBody,
    timeline: [
      goatBrainTimelineEntryFromParts({
        evidenceId,
        at: now,
        summary: `Created from Goat task ${input.taskId}.`,
        sourceRef: `goat-task:${input.taskId}`,
        sourceTitle: `Task ${input.taskId}`,
      }),
    ],
  };
  const content = serializeGoatBrainDocument(doc);
  if (Buffer.byteLength(content, "utf8") > MAX_GOAT_BRAIN_MARKDOWN_DOCUMENT_BYTES) {
    throw new Error("Goat research report is too large to save to the Brain.");
  }
  const row = await upsertGoatBrainFile(
    {
      brainRef,
      userWorkosId: input.userWorkosId,
      path: goatBrainFilePathFor(folderPath, brainId),
      content,
      id: `goat_brain_file_${randomUUID()}`,
    },
    { db: getDb() },
  );

  return {
    type: "brain_markdown_report",
    title,
    documentId: row.id,
    brainId,
    folderPath,
    brainPath: goatBrainFilePathFor(folderPath, brainId),
    url: brainDocumentUrl(folderPath, brainId),
    mimeType: GOAT_BRAIN_FILE_MIME_TYPE,
  };
}

export async function materializeGoatBrainForTask(input: {
  sandbox: SandboxHandle;
  userWorkosId: string;
}): Promise<MaterializedGoatBrainSnapshot> {
  const brainRef = await resolveGoatBrainRefForUser(input.userWorkosId);
  const rows = await listGoatBrainFiles(
    { brainRef },
    {
      includeInvalid: true,
      db: getDb(),
    },
  );
  const folderRows = await listGoatBrainFolderRows({ brainRef }, { db: getDb() });
  await input.sandbox.commands.run(
    `rm -rf ${shellQuote(GOAT_BRAIN_ROOT)} && mkdir -p ${shellQuote(GOAT_BRAIN_ROOT)}`,
    { timeoutMs: 30_000 },
  );
  await input.sandbox.commands.run(`mkdir -p ${shellQuote(`${GOAT_BRAIN_ROOT}/.brain`)}`, {
    timeoutMs: 30_000,
  });
  await input.sandbox.files.write(
    `${GOAT_BRAIN_ROOT}/${GOAT_BRAIN_FOLDER_MANIFEST_PATH}`,
    serializeGoatBrainFolderManifest(folderRows),
  );
  await input.sandbox.files.write(GOAT_BRAIN_CLI_PATH, getGoatBrainCliSource());
  await input.sandbox.commands.run(`chmod 700 ${shellQuote(GOAT_BRAIN_CLI_PATH)}`, {
    timeoutMs: 30_000,
  });

  const files: MaterializedGoatBrainFile[] = [];
  for (const row of rows) {
    const relativePath = goatBrainFilePathFor(row.folderPath, row.brainId);
    await input.sandbox.commands.run(
      `mkdir -p ${shellQuote(`${GOAT_BRAIN_ROOT}/${path.posix.dirname(relativePath)}`)}`,
      { timeoutMs: 30_000 },
    );
    await input.sandbox.files.write(`${GOAT_BRAIN_ROOT}/${relativePath}`, row.content);
    files.push(materializedFileFromDb({ ...row, path: relativePath }));
  }
  return { files };
}

export async function materializeGoatBrainToLocalRoot(input: {
  root: string;
  userWorkosId: string;
}): Promise<MaterializedGoatBrainSnapshot & { cliPath: string }> {
  const brainRef = await resolveGoatBrainRefForUser(input.userWorkosId);
  const files = await materializeGoatBrainFilesToRoot({
    brainRef,
    root: input.root,
    cliSource: getGoatBrainCliSource(),
    db: getDb(),
  });
  return {
    files: files.map(materializedFileFromDb),
    cliPath: path.join(input.root, "goat-brain.mjs"),
  };
}

export async function syncGoatBrainFromSandbox(input: {
  sandbox: SandboxHandle;
  userWorkosId: string;
  taskId?: string | null;
  baseSnapshot: MaterializedGoatBrainSnapshot;
}): Promise<void> {
  const listed = await input.sandbox.commands.run(
    `if [ -d ${shellQuote(GOAT_BRAIN_ROOT)} ]; then find ${shellQuote(
      GOAT_BRAIN_ROOT,
    )} -type f -name '*.md' -not -path '*/.*/*' | sort; fi`,
    { timeoutMs: 30_000 },
  );
  const files: GoatBrainSyncFile[] = [];
  for (const absolutePath of listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (!absolutePath.startsWith(`${GOAT_BRAIN_ROOT}/`)) continue;
    const relativePath = absolutePath.slice(`${GOAT_BRAIN_ROOT}/`.length);
    const content = String(await input.sandbox.files.read(absolutePath));
    if (Buffer.byteLength(content, "utf8") > MAX_GOAT_BRAIN_SANDBOX_FILE_BYTES) {
      throw new Error(`Brain file "${relativePath}" is too large to sync.`);
    }
    files.push({ path: relativePath, content });
  }
  const folders = await readSandboxFolderManifest(input.sandbox);
  await syncFiles({
    userWorkosId: input.userWorkosId,
    files,
    folders,
    baseSnapshot: input.baseSnapshot,
    taskId: input.taskId ?? null,
  });
}

export async function syncGoatBrainFromLocalRoot(input: {
  root: string;
  userWorkosId: string;
  taskId?: string | null;
  baseSnapshot: MaterializedGoatBrainSnapshot;
}): Promise<void> {
  const files = await readGoatBrainFilesFromRoot(input.root);
  await syncFiles({
    userWorkosId: input.userWorkosId,
    files,
    baseSnapshot: input.baseSnapshot,
    taskId: input.taskId ?? null,
  });
}

async function syncFiles(input: {
  userWorkosId: string;
  files: GoatBrainSyncFile[];
  folders?: ReturnType<typeof parseGoatBrainFolderManifest> | null;
  baseSnapshot: MaterializedGoatBrainSnapshot;
  taskId?: string | null;
}) {
  const brainRef = await resolveGoatBrainRefForUser(input.userWorkosId);
  const result = await syncGoatBrainFiles({
    brainRef,
    userWorkosId: input.userWorkosId,
    files: input.files,
    folders: input.folders ?? null,
    baseSnapshot: input.baseSnapshot.files.map(dbMaterializedFileFromRunner),
    taskId: input.taskId ?? null,
    db: getDb(),
  });
  if (result.conflicts.length > 0) {
    throw new Error(
      `Brain changed while the task was running. Retry before writing ${result.conflicts
        .map((conflict) => conflict.path)
        .join(", ")}.`,
    );
  }
}

async function readSandboxFolderManifest(sandbox: SandboxHandle) {
  try {
    const source = String(
      await sandbox.files.read(`${GOAT_BRAIN_ROOT}/${GOAT_BRAIN_FOLDER_MANIFEST_PATH}`),
    );
    return parseGoatBrainFolderManifest(source);
  } catch {
    return null;
  }
}

function materializedFileFromDb(input: DbMaterializedGoatBrainFile): MaterializedGoatBrainFile;
function materializedFileFromDb(input: {
  id: string;
  brainId: string;
  folderPath: string;
  path: string;
  contentHash: string;
}): MaterializedGoatBrainFile;
function materializedFileFromDb(input: {
  id: string;
  brainId: string;
  folderPath: string;
  path: string;
  contentHash: string;
}): MaterializedGoatBrainFile {
  return {
    documentId: input.id,
    brainId: input.brainId,
    folderPath: input.folderPath,
    relativePath: input.path,
    contentHash: input.contentHash,
  };
}

function dbMaterializedFileFromRunner(
  input: MaterializedGoatBrainFile,
): DbMaterializedGoatBrainFile {
  return {
    id: input.documentId,
    brainId: input.brainId,
    folderPath: input.folderPath,
    path: input.relativePath,
    contentHash: input.contentHash,
  };
}

// Runner work has no interactive session, so it targets the user's default
// ("General") brain; the chat surface targets the user's active brain instead.
async function resolveGoatBrainRefForUser(userWorkosId: string): Promise<string> {
  const brain = await getDefaultGoatBrainForUser(userWorkosId, { db: getDb() });
  if (!brain) {
    throw new Error(`No accessible Goat brain found for user ${userWorkosId}.`);
  }
  return brain.id;
}

function nextAvailableBrainId(
  rows: Awaited<ReturnType<typeof listGoatBrainFiles>>,
  title: string,
): string {
  const base = normalizeGoatBrainId(title) || "research-report";
  const used = new Set(rows.map((row) => row.brainId));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique brain id.");
}

function firstMarkdownHeading(markdown: string) {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function brainDocumentUrl(folderPath: string, brainId: string) {
  return `/brain/${folderPath}/${brainId}`;
}

export async function writeLocalBrainFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function readLocalBrainFile(root: string, relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

export async function clearLocalBrainRoot(root: string) {
  await rm(root, { recursive: true, force: true });
}
