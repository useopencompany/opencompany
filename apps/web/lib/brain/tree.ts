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
    const parts = file.path.split("/").filter(Boolean);
    let current = root;

    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = current.children.find((item) => item.path === path);

      if (!child) {
        child = {
          name: part,
          path,
          type: index === parts.length - 1 ? "file" : "folder",
          children: [],
        };
        current.children.push(child);
        sortTreeNodes(current.children);
      }

      if (index === parts.length - 1) {
        child.file = file;
      }

      current = child;
    });
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
