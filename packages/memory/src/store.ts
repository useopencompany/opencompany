import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "./document";
import { idFromRelativePath, relativePathForType } from "./paths";
import type { MemoryDocument } from "./schema";
import { type ValidationResult, validateDocument } from "./validate";

// A memory file located on disk: its path relative to the memory root, plus the raw text.
export type StoredFile = {
  relativePath: string;
  id: string;
  source: string;
};

// Filesystem layer over the memory root (default `agent/memory`). Pure-ish: every method takes
// the resolved absolute root so the CLI controls `--root` once and tests point at a temp dir.

export function resolveRoot(explicit: string | undefined, cwd: string = process.cwd()): string {
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(cwd, explicit);
  }
  return path.resolve(cwd, "agent/memory");
}

// Walk the tree and return every markdown file that sits directly inside a known folder.
export async function listFiles(root: string): Promise<StoredFile[]> {
  const relativePaths = await walkMarkdown(root, "");

  const files: StoredFile[] = [];
  for (const relativePath of relativePaths) {
    const id = idFromRelativePath(relativePath);
    if (!id) continue;
    const source = await readFile(path.join(root, relativePath), "utf8");
    files.push({ relativePath, id, source });
  }
  return files;
}

// Recursively collect markdown files as root-relative POSIX paths. We do the recursion by hand
// (one non-recursive readdir per directory, building each child's path from the directory we're
// in) rather than `readdir(root, { recursive: true })` + `Dirent.parentPath`: that property only
// exists on Node >= 20.12, and on the older Node in the sandbox runtime it is `undefined`, so
// `path.join(entry.parentPath, ...)` threw "path argument must be of type string. Received
// undefined" for every `get`/`query`.
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
      found.push(...(await walkMarkdown(root, childRel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(toPosix(childRel));
    }
  }
  return found;
}

// Find a file by id anywhere in the tree (ids are globally unique, so the folder is incidental).
export async function findFile(root: string, id: string): Promise<StoredFile | null> {
  const files = await listFiles(root);
  return files.find((file) => file.id === id) ?? null;
}

// Load + strictly validate a single document. Returns null when the id is absent.
export async function loadDocument(
  root: string,
  id: string,
): Promise<{ relativePath: string; result: ValidationResult } | null> {
  const file = await findFile(root, id);
  if (!file) return null;
  return {
    relativePath: file.relativePath,
    result: validateDocument(parseDocument(file.source), id),
  };
}

// True if any file in the tree already uses this id — the uniqueness guard for create/append.
export async function idExists(root: string, id: string): Promise<boolean> {
  return (await findFile(root, id)) !== null;
}

// Atomic write: serialize is the caller's job; we mkdir the folder, write a temp sibling, then
// rename into place so a crash never leaves a half-written memory file.
export async function writeDocumentText(
  root: string,
  relativePath: string,
  text: string,
): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, target);
}

// Convenience: the on-disk path a document of a given type+id should occupy.
export function pathForDocument(doc: MemoryDocument): string {
  return relativePathForType(doc.frontmatter.type, doc.frontmatter.id);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: string }).code === "ENOENT",
  );
}
