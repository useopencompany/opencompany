import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseBrainDocument } from "./document";
import {
  type BrainEntry,
  brainEntryFromLegacyDocument,
  brainPayloadRelativePath,
  brainSidecarRelativePath,
  parseBrainSidecar,
  recoverLegacyBrainEntryFromSidecar,
  serializeBrainPayload,
  serializeBrainSidecar,
  serializeLegacyBrainEntry,
  validateBrainSidecar,
} from "./entry";
import {
  BRAIN_FOLDER_MANIFEST_PATH,
  type BrainFolderManifestEntry,
  defaultBrainFolderManifestEntries,
  normalizeBrainFolderEntries,
  parseBrainFolderManifest,
  serializeBrainFolderManifest,
} from "./folders";
import { brainFolderFromRelativePath, brainIdFromRelativePath, brainRelativePath } from "./paths";
import type { BrainDocument } from "./schema";
import { type BrainValidationResult, validateBrainDocument } from "./validate";

export type StoredBrainFile = {
  relativePath: string;
  id: string;
  source: string;
};

export function resolveBrainRoot(explicit: string | undefined, cwd: string = process.cwd()) {
  const pinned = process.env.BRAIN_ROOT?.trim();
  if (pinned) return path.resolve(cwd, pinned);
  if (explicit && explicit.trim().length > 0) return path.resolve(cwd, explicit);
  return path.resolve(cwd, "goat-brain");
}

export async function listBrainFiles(root: string): Promise<StoredBrainFile[]> {
  const relativePaths = await walkMarkdown(root, "");
  const files: StoredBrainFile[] = [];
  for (const relativePath of relativePaths) {
    const id = brainIdFromRelativePath(relativePath);
    if (!id) continue;
    const payload = await readFile(path.join(root, relativePath), "utf8");
    const source = await sourceFromSidecarOrPayload(root, relativePath, payload);
    files.push({ relativePath, id, source });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function findBrainFile(root: string, id: string): Promise<StoredBrainFile | null> {
  const relativePaths = (await walkMarkdown(root, "")).sort((a, b) => a.localeCompare(b));
  const relativePath = relativePaths.find((filePath) => brainIdFromRelativePath(filePath) === id);
  if (!relativePath) return null;
  const payload = await readFile(path.join(root, relativePath), "utf8");
  const source = await sourceFromSidecarOrPayload(root, relativePath, payload);
  return { relativePath, id, source };
}

export async function loadBrainDocument(
  root: string,
  id: string,
): Promise<{ relativePath: string; result: BrainValidationResult; source: string } | null> {
  const file = await findBrainFile(root, id);
  if (!file) return null;
  const parsed = parseBrainDocument(file.source);
  return {
    relativePath: file.relativePath,
    source: file.source,
    result: validateBrainDocument(parsed, file.id, file.source),
  };
}

export async function writeBrainDocumentText(
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

export async function writeBrainEntry(root: string, entry: BrainEntry): Promise<string> {
  const payloadPath = brainPayloadRelativePath(
    entry.folder,
    entry.id,
    entry.format,
    entry.originalFileName,
  );
  const sidecarPath = brainSidecarRelativePath(entry.folder, entry.id);
  await writeBrainDocumentText(root, payloadPath, serializeBrainPayload(entry));
  await writeBrainDocumentText(root, sidecarPath, serializeBrainSidecar(entry));
  return payloadPath;
}

export function pathForBrainDocument(doc: BrainDocument): string {
  return brainRelativePath(doc.frontmatter.folder, doc.frontmatter.id);
}

export async function removeBrainFile(root: string, relativePath: string): Promise<void> {
  await rm(path.join(root, relativePath), { force: true });
  const id = brainIdFromRelativePath(relativePath);
  const folder = brainFolderFromRelativePath(relativePath);
  if (id && folder) {
    await rm(path.join(root, brainSidecarRelativePath(folder, id)), { force: true });
  }
}

export async function readBrainFolders(root: string): Promise<BrainFolderManifestEntry[]> {
  try {
    const source = await readFile(path.join(root, BRAIN_FOLDER_MANIFEST_PATH), "utf8");
    return parseBrainFolderManifest(source);
  } catch (error) {
    if (isNotFound(error)) return defaultBrainFolderManifestEntries();
    throw error;
  }
}

export async function writeBrainFolders(
  root: string,
  folders: Iterable<Partial<BrainFolderManifestEntry> & { path?: unknown; source?: unknown }>,
): Promise<void> {
  await writeBrainDocumentText(
    root,
    BRAIN_FOLDER_MANIFEST_PATH,
    serializeBrainFolderManifest(folders),
  );
}

export async function upsertBrainFolder(
  root: string,
  folder: BrainFolderManifestEntry,
): Promise<BrainFolderManifestEntry[]> {
  const byPath = new Map((await readBrainFolders(root)).map((entry) => [entry.path, entry]));
  byPath.set(folder.path, folder);
  const next = normalizeBrainFolderEntries(byPath.values());
  await writeBrainFolders(root, next);
  return next;
}

export async function removeBrainFolder(
  root: string,
  folderPath: string,
): Promise<BrainFolderManifestEntry[]> {
  const next = normalizeBrainFolderEntries(
    (await readBrainFolders(root)).filter((entry) => entry.path !== folderPath),
  );
  await writeBrainFolders(root, next);
  return next;
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
  const id = brainIdFromRelativePath(relativePath);
  const folder = brainFolderFromRelativePath(relativePath);
  if (!id || !folder) return payload;
  let sidecarSource: string;
  try {
    sidecarSource = await readFile(path.join(root, brainSidecarRelativePath(folder, id)), "utf8");
  } catch (error) {
    if (isNotFound(error)) return payload;
    throw error;
  }
  const sidecar = parseBrainSidecar(sidecarSource);
  const validation = validateBrainSidecar({
    sidecar,
    payloadContent: payload,
    payloadRelativePath: relativePath,
  });
  if (validation.ok) return serializeLegacyBrainEntry(validation.entry);
  return (
    recoverLegacyBrainEntryFromSidecar({
      sidecar,
      payloadContent: payload,
      payloadRelativePath: relativePath,
    }) ?? payload
  );
}

export function entryFromWritableBrainDocument(doc: BrainDocument): BrainEntry {
  return brainEntryFromLegacyDocument(doc);
}
