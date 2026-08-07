import { isValidGoatBrainFolder, isValidGoatBrainId, normalizeGoatBrainFolder } from "./schema";

export function goatBrainRelativePath(folder: string, id: string): string {
  const normalizedFolder = normalizeGoatBrainFolder(folder);
  if (!isValidGoatBrainFolder(normalizedFolder)) throw new Error("Invalid brain folder.");
  if (!isValidGoatBrainId(id)) throw new Error("Invalid brain id.");
  return `${normalizedFolder}/${id}.md`;
}

export function goatBrainIdFromRelativePath(relativePath: string): string | null {
  const split = splitGoatBrainRelativePath(relativePath);
  if (!split || !isValidGoatBrainFolder(split.folder) || !isValidGoatBrainId(split.id)) {
    return null;
  }
  return split.id;
}

export function goatBrainFolderFromRelativePath(relativePath: string): string | null {
  const split = splitGoatBrainRelativePath(relativePath);
  return split && isValidGoatBrainFolder(split.folder) ? split.folder : null;
}

export function isSafeGoatBrainRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith("/")) return false;
  const parts = relativePath.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("."),
  );
}

function splitGoatBrainRelativePath(relativePath: string): { folder: string; id: string } | null {
  const match = /^(.+)\/([^/]+)\.md$/.exec(relativePath);
  if (!match) return null;
  const [, folder, id] = match;
  return folder && id ? { folder, id } : null;
}
