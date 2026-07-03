import { isValidGoatBrainFolder, isValidGoatBrainId, normalizeGoatBrainFolder } from "./schema";

export function goatBrainRelativePath(folder: string, id: string): string {
  const normalizedFolder = normalizeGoatBrainFolder(folder);
  if (!isValidGoatBrainFolder(normalizedFolder)) throw new Error("Invalid brain folder.");
  if (!isValidGoatBrainId(id)) throw new Error("Invalid brain id.");
  return `${normalizedFolder}/${id}.md`;
}

export function goatBrainIdFromRelativePath(relativePath: string): string | null {
  const match = /^(.+)\/([^/]+)\.md$/.exec(relativePath);
  if (!match) return null;
  const [, folder, id] = match;
  if (!folder || !id || !isValidGoatBrainFolder(folder) || !isValidGoatBrainId(id)) return null;
  return id;
}

export function goatBrainFolderFromRelativePath(relativePath: string): string | null {
  const match = /^(.+)\/([^/]+)\.md$/.exec(relativePath);
  const folder = match?.[1];
  return folder && isValidGoatBrainFolder(folder) ? folder : null;
}

export function isSafeGoatBrainRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith("/")) return false;
  const parts = relativePath.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("."),
  );
}
