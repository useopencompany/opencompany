import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGoatBrainDocument } from "./document";
import {
  type GoatBrainEntry,
  goatBrainEntryFromLegacyDocument,
  goatBrainPayloadRelativePath,
  goatBrainSidecarRelativePath,
  parseGoatBrainSidecar,
  recoverLegacyGoatBrainEntryFromSidecar,
  serializeGoatBrainPayload,
  serializeGoatBrainSidecar,
  serializeLegacyGoatBrainEntry,
  validateGoatBrainSidecar,
} from "./entry";
import {
  goatBrainFolderFromRelativePath,
  goatBrainIdFromRelativePath,
  goatBrainRelativePath,
} from "./paths";
import type { GoatBrainDocument } from "./schema";
import { type GoatBrainValidationResult, validateGoatBrainDocument } from "./validate";

export type StoredGoatBrainFile = {
  relativePath: string;
  id: string;
  source: string;
};

export function resolveGoatBrainRoot(explicit: string | undefined, cwd: string = process.cwd()) {
  const pinned = process.env.GOAT_BRAIN_ROOT?.trim();
  if (pinned) return path.resolve(cwd, pinned);
  if (explicit && explicit.trim().length > 0) return path.resolve(cwd, explicit);
  return path.resolve(cwd, "goat-brain");
}

export async function listGoatBrainFiles(root: string): Promise<StoredGoatBrainFile[]> {
  const relativePaths = await walkMarkdown(root, "");
  const files: StoredGoatBrainFile[] = [];
  for (const relativePath of relativePaths) {
    const id = goatBrainIdFromRelativePath(relativePath);
    if (!id) continue;
    const payload = await readFile(path.join(root, relativePath), "utf8");
    const source = await sourceFromSidecarOrPayload(root, relativePath, payload);
    files.push({ relativePath, id, source });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function findGoatBrainFile(
  root: string,
  id: string,
): Promise<StoredGoatBrainFile | null> {
  const relativePaths = (await walkMarkdown(root, "")).sort((a, b) => a.localeCompare(b));
  const relativePath = relativePaths.find(
    (filePath) => goatBrainIdFromRelativePath(filePath) === id,
  );
  if (!relativePath) return null;
  const payload = await readFile(path.join(root, relativePath), "utf8");
  const source = await sourceFromSidecarOrPayload(root, relativePath, payload);
  return { relativePath, id, source };
}

export async function loadGoatBrainDocument(
  root: string,
  id: string,
): Promise<{ relativePath: string; result: GoatBrainValidationResult; source: string } | null> {
  const file = await findGoatBrainFile(root, id);
  if (!file) return null;
  const parsed = parseGoatBrainDocument(file.source);
  return {
    relativePath: file.relativePath,
    source: file.source,
    result: validateGoatBrainDocument(parsed, file.id, file.source),
  };
}

export async function writeGoatBrainDocumentText(
  root: string,
  relativePath: string,
  text: string,
): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${randomUUID()}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, target);
}

export async function writeGoatBrainEntry(root: string, entry: GoatBrainEntry): Promise<string> {
  const payloadPath = goatBrainPayloadRelativePath(
    entry.folder,
    entry.id,
    entry.kind,
    entry.originalFileName,
  );
  const sidecarPath = goatBrainSidecarRelativePath(entry.folder, entry.id);
  await writeGoatBrainDocumentText(root, payloadPath, serializeGoatBrainPayload(entry));
  await writeGoatBrainDocumentText(root, sidecarPath, serializeGoatBrainSidecar(entry));
  return payloadPath;
}

export function pathForGoatBrainDocument(doc: GoatBrainDocument): string {
  return goatBrainRelativePath(doc.frontmatter.folder, doc.frontmatter.id);
}

export async function removeGoatBrainFile(root: string, relativePath: string): Promise<void> {
  await rm(path.join(root, relativePath), { force: true });
  const id = goatBrainIdFromRelativePath(relativePath);
  const folder = goatBrainFolderFromRelativePath(relativePath);
  if (id && folder) {
    await rm(path.join(root, goatBrainSidecarRelativePath(folder, id)), { force: true });
  }
}

async function walkMarkdown(root: string, relDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, relDir), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".brain") continue;
      found.push(...(await walkMarkdown(root, childRel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(childRel.split(path.sep).join("/"));
    }
  }
  return found;
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: string }).code === "ENOENT",
  );
}

async function sourceFromSidecarOrPayload(root: string, relativePath: string, payload: string) {
  const id = goatBrainIdFromRelativePath(relativePath);
  const folder = goatBrainFolderFromRelativePath(relativePath);
  if (!id || !folder) return payload;
  let sidecarSource: string;
  try {
    sidecarSource = await readFile(
      path.join(root, goatBrainSidecarRelativePath(folder, id)),
      "utf8",
    );
  } catch (error) {
    if (isNotFound(error)) return payload;
    throw error;
  }
  const sidecar = parseGoatBrainSidecar(sidecarSource);
  const validation = validateGoatBrainSidecar({
    sidecar,
    payloadContent: payload,
    payloadRelativePath: relativePath,
  });
  if (validation.ok) return serializeLegacyGoatBrainEntry(validation.entry);
  return (
    recoverLegacyGoatBrainEntryFromSidecar({
      sidecar,
      payloadContent: payload,
      payloadRelativePath: relativePath,
    }) ?? payload
  );
}

export function entryFromWritableGoatBrainDocument(doc: GoatBrainDocument): GoatBrainEntry {
  return goatBrainEntryFromLegacyDocument(doc);
}
