import { isValidBrainFolder, isValidBrainId, normalizeBrainFolder } from "./schema";

export function brainRelativePath(folder: string, id: string): string {
  const normalizedFolder = normalizeBrainFolder(folder);
  if (!isValidBrainFolder(normalizedFolder)) throw new Error("Invalid brain folder.");
  if (!isValidBrainId(id)) throw new Error("Invalid brain id.");
  return `${normalizedFolder}/${id}.md`;
}

export function brainIdFromRelativePath(relativePath: string): string | null {
  const split = splitBrainRelativePath(relativePath);
  if (!split || !isValidBrainFolder(split.folder) || !isValidBrainId(split.id)) {
    return null;
  }
  return split.id;
}

export function brainFolderFromRelativePath(relativePath: string): string | null {
  const split = splitBrainRelativePath(relativePath);
  return split && isValidBrainFolder(split.folder) ? split.folder : null;
}

export function isSafeBrainRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith("/")) return false;
  const parts = relativePath.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("."),
  );
}

function splitBrainRelativePath(relativePath: string): { folder: string; id: string } | null {
  const match = /^(.+)\/([^/]+)\.md$/.exec(relativePath);
  if (!match) return null;
  const [, folder, id] = match;
  return folder && id ? { folder, id } : null;
}
