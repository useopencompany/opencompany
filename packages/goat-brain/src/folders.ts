import {
  ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS,
  DEFAULT_GOAT_BRAIN_FOLDERS,
  GOAT_BRAIN_MIDDLE_FOLDER_ORDER,
  HARD_DEFAULT_GOAT_BRAIN_FOLDERS,
  isHardDefaultGoatBrainFolder,
  isValidGoatBrainFolder,
  normalizeGoatBrainFolder,
} from "./schema";

export type GoatBrainFolderSource = "system" | "custom";

export type GoatBrainFolderManifestEntry = {
  path: string;
  source: GoatBrainFolderSource;
};

export type GoatBrainFolderManifest = {
  schemaVersion: "goat.brain.folders.v1";
  folders: GoatBrainFolderManifestEntry[];
};

export const GOAT_BRAIN_FOLDER_MANIFEST_PATH = ".brain/folders.json";

const DEFAULT_FOLDER_SET = new Set<string>(DEFAULT_GOAT_BRAIN_FOLDERS);
const HARD_FOLDER_SET = new Set<string>(HARD_DEFAULT_GOAT_BRAIN_FOLDERS);
const MIDDLE_FOLDER_RANK = new Map<string, number>(
  GOAT_BRAIN_MIDDLE_FOLDER_ORDER.map((folder, index) => [folder, index]),
);
const ENTITY_FOLDER_RANK = new Map<string, number>([
  ["people", 0],
  ["companies", 1],
]);

export function defaultGoatBrainFolderManifestEntries(): GoatBrainFolderManifestEntry[] {
  return [
    ...hardDefaultGoatBrainFolderManifestEntries(),
    ...ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS.map((path) => ({
      path,
      source: "custom" as const,
    })),
  ].toSorted((a, b) => compareGoatBrainFolderPaths(a.path, b.path));
}

export function hardDefaultGoatBrainFolderManifestEntries(): GoatBrainFolderManifestEntry[] {
  return HARD_DEFAULT_GOAT_BRAIN_FOLDERS.map((path) => ({
    path,
    source: "system" as const,
  })).toSorted((a, b) => compareGoatBrainFolderPaths(a.path, b.path));
}

export function goatBrainFolderSourceForPath(path: string): GoatBrainFolderSource {
  return isHardDefaultGoatBrainFolder(path) ? "system" : "custom";
}

export function normalizeGoatBrainFolderEntries(
  folders: Iterable<Partial<GoatBrainFolderManifestEntry> & { path?: unknown; source?: unknown }>,
  options: { includeAdjustableDefaults?: boolean } = {},
): GoatBrainFolderManifestEntry[] {
  const byPath = new Map<string, GoatBrainFolderManifestEntry>();
  for (const entry of folders) {
    if (typeof entry.path !== "string") continue;
    const path = normalizeGoatBrainFolder(entry.path);
    if (!isValidGoatBrainFolder(path)) continue;
    const source =
      entry.source === "system" && HARD_FOLDER_SET.has(path)
        ? "system"
        : goatBrainFolderSourceForPath(path);
    const existing = byPath.get(path);
    byPath.set(path, {
      path,
      source: existing?.source === "system" || source === "system" ? "system" : "custom",
    });
  }
  const defaults = options.includeAdjustableDefaults
    ? defaultGoatBrainFolderManifestEntries()
    : hardDefaultGoatBrainFolderManifestEntries();
  for (const entry of defaults) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  }
  return [...byPath.values()].toSorted((a, b) => compareGoatBrainFolderPaths(a.path, b.path));
}

export function parseGoatBrainFolderManifest(source: string): GoatBrainFolderManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return defaultGoatBrainFolderManifestEntries();
  }
  if (!parsed || typeof parsed !== "object") return defaultGoatBrainFolderManifestEntries();
  const folders = (parsed as { folders?: unknown }).folders;
  if (!Array.isArray(folders)) return defaultGoatBrainFolderManifestEntries();
  return normalizeGoatBrainFolderEntries(folders as GoatBrainFolderManifestEntry[]);
}

export function serializeGoatBrainFolderManifest(
  folders: Iterable<Partial<GoatBrainFolderManifestEntry> & { path?: unknown; source?: unknown }>,
): string {
  const manifest: GoatBrainFolderManifest = {
    schemaVersion: "goat.brain.folders.v1",
    folders: normalizeGoatBrainFolderEntries(folders),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function compareGoatBrainFolderPaths(a: string, b: string): number {
  const aRoot = a.split("/")[0] ?? a;
  const bRoot = b.split("/")[0] ?? b;
  const aGroup = goatBrainRootFolderGroup(aRoot);
  const bGroup = goatBrainRootFolderGroup(bRoot);
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

export function isDefaultGoatBrainFolder(path: string): boolean {
  return DEFAULT_FOLDER_SET.has(normalizeGoatBrainFolder(path));
}

export function goatBrainRootFolderGroup(root: string): 0 | 1 | 2 {
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
