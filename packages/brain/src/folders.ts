import {
  ADJUSTABLE_DEFAULT_BRAIN_FOLDERS,
  BRAIN_MIDDLE_FOLDER_ORDER,
  DEFAULT_BRAIN_FOLDERS,
  HARD_DEFAULT_BRAIN_FOLDERS,
  isHardDefaultBrainFolder,
  isValidBrainFolder,
  normalizeBrainFolder,
} from "./schema";

export type BrainFolderSource = "system" | "custom";

export type BrainFolderManifestEntry = {
  path: string;
  source: BrainFolderSource;
};

export type BrainFolderManifest = {
  schemaVersion: "goat.brain.folders.v1";
  folders: BrainFolderManifestEntry[];
};

export const BRAIN_FOLDER_MANIFEST_PATH = ".brain/folders.json";

const DEFAULT_FOLDER_SET = new Set<string>(DEFAULT_BRAIN_FOLDERS);
const HARD_FOLDER_SET = new Set<string>(HARD_DEFAULT_BRAIN_FOLDERS);
const MIDDLE_FOLDER_RANK = new Map<string, number>(
  BRAIN_MIDDLE_FOLDER_ORDER.map((folder, index) => [folder, index]),
);
const ENTITY_FOLDER_RANK = new Map<string, number>([
  ["people", 0],
  ["companies", 1],
]);

export function defaultBrainFolderManifestEntries(): BrainFolderManifestEntry[] {
  return [
    ...hardDefaultBrainFolderManifestEntries(),
    ...ADJUSTABLE_DEFAULT_BRAIN_FOLDERS.map((path) => ({
      path,
      source: "custom" as const,
    })),
  ].toSorted((a, b) => compareBrainFolderPaths(a.path, b.path));
}

export function hardDefaultBrainFolderManifestEntries(): BrainFolderManifestEntry[] {
  return HARD_DEFAULT_BRAIN_FOLDERS.map((path) => ({
    path,
    source: "system" as const,
  })).toSorted((a, b) => compareBrainFolderPaths(a.path, b.path));
}

export function brainFolderSourceForPath(path: string): BrainFolderSource {
  return isHardDefaultBrainFolder(path) ? "system" : "custom";
}

export function normalizeBrainFolderEntries(
  folders: Iterable<Partial<BrainFolderManifestEntry> & { path?: unknown; source?: unknown }>,
  options: { includeAdjustableDefaults?: boolean } = {},
): BrainFolderManifestEntry[] {
  const byPath = new Map<string, BrainFolderManifestEntry>();
  for (const entry of folders) {
    if (typeof entry.path !== "string") continue;
    const path = normalizeBrainFolder(entry.path);
    if (!isValidBrainFolder(path)) continue;
    const source =
      entry.source === "system" && HARD_FOLDER_SET.has(path)
        ? "system"
        : brainFolderSourceForPath(path);
    const existing = byPath.get(path);
    byPath.set(path, {
      path,
      source: existing?.source === "system" || source === "system" ? "system" : "custom",
    });
  }
  const defaults = options.includeAdjustableDefaults
    ? defaultBrainFolderManifestEntries()
    : hardDefaultBrainFolderManifestEntries();
  for (const entry of defaults) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  }
  return [...byPath.values()].toSorted((a, b) => compareBrainFolderPaths(a.path, b.path));
}

export function parseBrainFolderManifest(source: string): BrainFolderManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return defaultBrainFolderManifestEntries();
  }
  if (!parsed || typeof parsed !== "object") return defaultBrainFolderManifestEntries();
  const folders = (parsed as { folders?: unknown }).folders;
  if (!Array.isArray(folders)) return defaultBrainFolderManifestEntries();
  return normalizeBrainFolderEntries(folders as BrainFolderManifestEntry[]);
}

export function serializeBrainFolderManifest(
  folders: Iterable<Partial<BrainFolderManifestEntry> & { path?: unknown; source?: unknown }>,
): string {
  const manifest: BrainFolderManifest = {
    schemaVersion: "goat.brain.folders.v1",
    folders: normalizeBrainFolderEntries(folders),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function compareBrainFolderPaths(a: string, b: string): number {
  const aRoot = a.split("/")[0] ?? a;
  const bRoot = b.split("/")[0] ?? b;
  const aGroup = brainRootFolderGroup(aRoot);
  const bGroup = brainRootFolderGroup(bRoot);
  if (aGroup !== bGroup) return aGroup - bGroup;
  if (aGroup === 1 && aRoot !== bRoot) {
    const aRank = middleRootRank(aRoot);
    const bRank = middleRootRank(bRoot);
    if (aRank.bucket !== bRank.bucket) return aRank.bucket - bRank.bucket;
    if (aRank.rank !== bRank.rank) return aRank.rank - bRank.rank;
  }
  if (aRoot !== bRoot) return aRoot.localeCompare(bRoot);
  return a.localeCompare(b);
}

export function isDefaultBrainFolder(path: string): boolean {
  return DEFAULT_FOLDER_SET.has(normalizeBrainFolder(path));
}

export function brainRootFolderGroup(root: string): 0 | 1 | 2 {
  if (root === "inbox") return 0;
  if (root === "evidence") return 2;
  return 1;
}

function middleRootRank(root: string): { bucket: number; rank: number } {
  const defaultRank = MIDDLE_FOLDER_RANK.get(root);
  if (defaultRank !== undefined) return { bucket: 0, rank: defaultRank };
  const entityRank = ENTITY_FOLDER_RANK.get(root);
  if (entityRank !== undefined) return { bucket: 2, rank: entityRank };
  return { bucket: 1, rank: 0 };
}
