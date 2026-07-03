import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGoatBrainDocument } from "./document";
import { goatBrainIdFromRelativePath, goatBrainRelativePath } from "./paths";
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
    const source = await readFile(path.join(root, relativePath), "utf8");
    files.push({ relativePath, id, source });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function findGoatBrainFile(
  root: string,
  id: string,
): Promise<StoredGoatBrainFile | null> {
  const files = await listGoatBrainFiles(root);
  return files.find((file) => file.id === id) ?? null;
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
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, target);
}

export function pathForGoatBrainDocument(doc: GoatBrainDocument): string {
  return goatBrainRelativePath(doc.frontmatter.folder, doc.frontmatter.id);
}

export async function removeGoatBrainFile(root: string, relativePath: string): Promise<void> {
  await rm(path.join(root, relativePath), { force: true });
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
