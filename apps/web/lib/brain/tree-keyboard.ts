import { type FlatBrainNode, parentFolderPath } from "./tree";

export type BrainTreeKeyAction =
  | { type: "focus"; path: string }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string }
  | { type: "open"; path: string }
  | { type: "toggle"; path: string }
  | { type: "rename"; path: string }
  | { type: "delete"; path: string };

export function resolveBrainTreeKeyNav(
  key: string,
  state: { nodes: FlatBrainNode[]; focusedPath: string; expandedPaths: Set<string> },
): BrainTreeKeyAction | null {
  const { nodes, focusedPath, expandedPaths } = state;
  if (nodes.length === 0) return null;
  const index = nodes.findIndex((node) => node.path === focusedPath);
  const current = index >= 0 ? nodes[index] : null;

  switch (key) {
    case "ArrowDown": {
      const next = index < 0 ? 0 : Math.min(index + 1, nodes.length - 1);
      if (next === index) return null;
      return { type: "focus", path: nodes[next]!.path }; // bounds checked above
    }
    case "ArrowUp": {
      const prev = index < 0 ? 0 : Math.max(index - 1, 0);
      if (prev === index) return null;
      return { type: "focus", path: nodes[prev]!.path }; // bounds checked above
    }
    case "ArrowRight": {
      if (!current || current.type !== "folder") return null;
      if (!expandedPaths.has(current.path)) return { type: "expand", path: current.path };
      const child = nodes[index + 1];
      if (child && child.depth > current.depth) return { type: "focus", path: child.path };
      return null;
    }
    case "ArrowLeft": {
      if (!current) return null;
      if (current.type === "folder" && expandedPaths.has(current.path)) {
        return { type: "collapse", path: current.path };
      }
      const parent = parentFolderPath(current.path);
      return parent ? { type: "focus", path: parent } : null;
    }
    case "Enter": {
      if (!current) return null;
      return current.type === "file"
        ? { type: "open", path: current.path }
        : { type: "toggle", path: current.path };
    }
    case "F2": {
      if (!current) return null;
      return { type: "rename", path: current.path };
    }
    case "Delete":
    case "Backspace": {
      if (!current) return null;
      return { type: "delete", path: current.path };
    }
    default:
      return null;
  }
}

export function findTypeAheadMatch(
  nodes: FlatBrainNode[],
  buffer: string,
  fromIndex: number,
): string | null {
  if (!buffer || nodes.length === 0) return null;
  const needle = buffer.toLowerCase();
  const count = nodes.length;
  const start = fromIndex < 0 ? 0 : fromIndex;
  for (let offset = 1; offset <= count; offset += 1) {
    const node = nodes[(start + offset) % count];
    if (node && node.name.toLowerCase().startsWith(needle)) return node.path;
  }
  return null;
}
