import { isBrainFolderPlaceholder } from "./paths";

export type BrainTreeFile = {
  path: string;
};

export type BrainTreeNode<TFile extends BrainTreeFile = BrainTreeFile> = {
  name: string;
  path: string;
  type: "folder" | "file";
  children: Array<BrainTreeNode<TFile>>;
  file?: TFile;
};

export type FlatBrainNode = {
  path: string;
  name: string;
  type: "folder" | "file";
  depth: number;
};

export function flattenVisibleTree<TFile extends BrainTreeFile>(
  tree: BrainTreeNode<TFile>,
  expandedPaths: Set<string>,
): FlatBrainNode[] {
  const flat: FlatBrainNode[] = [];

  const walk = (nodes: Array<BrainTreeNode<TFile>>, depth: number) => {
    for (const node of nodes) {
      flat.push({ path: node.path, name: node.name, type: node.type, depth });
      if (node.type === "folder" && expandedPaths.has(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  };

  walk(tree.children, 0);
  return flat;
}

export function buildBrainTree<TFile extends BrainTreeFile>(
  files: TFile[],
  query = "",
): BrainTreeNode<TFile> {
  const root: BrainTreeNode<TFile> = { name: "", path: "", type: "folder", children: [] };
  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery
    ? files.filter((file) => file.path.toLowerCase().includes(normalizedQuery))
    : files;

  for (const file of visible) {
    // Placeholder files keep an otherwise-empty folder alive but must not appear
    // as a row in the tree, so we build their ancestor folders and drop the leaf.
    const isPlaceholder = isBrainFolderPlaceholder(file.path);
    const parts = file.path.split("/").filter(Boolean);
    const lastIndex = isPlaceholder ? parts.length - 2 : parts.length - 1;
    if (lastIndex < 0) continue;
    let current = root;

    for (let index = 0; index <= lastIndex; index += 1) {
      const part = parts[index];
      if (part === undefined) break;
      const path = parts.slice(0, index + 1).join("/");
      let child = current.children.find((item) => item.path === path);

      if (!child) {
        child = {
          name: part,
          path,
          type: index === lastIndex && !isPlaceholder ? "file" : "folder",
          children: [],
        };
        current.children.push(child);
        sortTreeNodes(current.children);
      }

      if (index === lastIndex && !isPlaceholder) {
        child.file = file;
      }

      current = child;
    }
  }

  return root;
}

export function collectFolderPaths<TFile extends BrainTreeFile>(
  node: BrainTreeNode<TFile>,
): string[] {
  const paths: string[] = [];

  for (const child of node.children) {
    if (child.type !== "folder") continue;
    paths.push(child.path, ...collectFolderPaths(child));
  }

  return paths;
}

export function ancestorFolderPaths(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function parentFolderPath(path: string) {
  const folders = ancestorFolderPaths(path);
  return folders.at(-1) ?? "";
}

/**
 * Whether `folderPath` still contains a real (non-placeholder) file other than
 * `excludePath`. Uses an exact `folder/` prefix so sibling folders that merely
 * share a name prefix ("notes" vs "notes-archive/x.md") do not count.
 */
export function hasOtherFilesInFolder<TFile extends BrainTreeFile>(
  files: TFile[],
  folderPath: string,
  excludePath: string,
) {
  if (!folderPath) return false;
  const prefix = `${folderPath}/`;
  return files.some(
    (file) =>
      file.path !== excludePath &&
      file.path.startsWith(prefix) &&
      !isBrainFolderPlaceholder(file.path),
  );
}

/**
 * Whether removing `removedPath` would leave the folder it lives in with no
 * remaining real files (placeholders ignored). Returns false at the root.
 */
export function isFolderEmptyAfterRemoving<TFile extends BrainTreeFile>(
  files: TFile[],
  removedPath: string,
) {
  const folderPath = parentFolderPath(removedPath);
  if (!folderPath) return false;
  return !hasOtherFilesInFolder(files, folderPath, removedPath);
}

export function uniqueNewBrainPath(files: BrainTreeFile[], contextPath = "") {
  const existing = new Set(files.map((file) => file.path));
  const folder = normalizeFolderContext(files, contextPath);
  const prefix = folder ? `${folder}/` : "";

  for (let index = 1; index < 100; index += 1) {
    const name = index === 1 ? "new-note.md" : `new-note-${index}.md`;
    const path = `${prefix}${name}`;
    if (!existing.has(path)) return path;
  }

  return `${prefix}new-note-${Date.now()}.md`;
}

function normalizeFolderContext(files: BrainTreeFile[], contextPath: string) {
  const normalized = contextPath.replace(/^\/+|\/+$/g, "");
  if (!normalized) return "notes";

  if (files.some((file) => file.path === normalized)) {
    return parentFolderPath(normalized);
  }

  return normalized;
}

function sortTreeNodes<TFile extends BrainTreeFile>(nodes: Array<BrainTreeNode<TFile>>) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
