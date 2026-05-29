import { useCallback, useRef } from "react";
import type { FlatBrainNode } from "@/lib/brain/tree";
import { findTypeAheadMatch, resolveBrainTreeKeyNav } from "@/lib/brain/tree-keyboard";

const TYPE_AHEAD_RESET_MS = 600;

type BrainTreeKeyboardOptions = {
  nodes: FlatBrainNode[];
  focusedPath: string;
  expandedPaths: Set<string>;
  onFocus: (path: string) => void;
  onExpand: (path: string) => void;
  onCollapse: (path: string) => void;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
};

export function useBrainTreeKeyboard(options: BrainTreeKeyboardOptions) {
  const bufferRef = useRef("");
  // 0 ensures the first keystroke always starts a fresh type-ahead buffer
  const lastKeyAtRef = useRef(0);

  const {
    nodes,
    focusedPath,
    expandedPaths,
    onFocus,
    onExpand,
    onCollapse,
    onOpen,
    onToggle,
    onRename,
    onDelete,
  } = options;

  return useCallback(
    (event: React.KeyboardEvent) => {
      const action = resolveBrainTreeKeyNav(event.key, { nodes, focusedPath, expandedPaths });
      if (action) {
        event.preventDefault();
        switch (action.type) {
          case "focus":
            onFocus(action.path);
            break;
          case "expand":
            onExpand(action.path);
            break;
          case "collapse":
            onCollapse(action.path);
            break;
          case "open":
            onOpen(action.path);
            break;
          case "toggle":
            onToggle(action.path);
            break;
          case "rename":
            onRename(action.path);
            break;
          case "delete":
            onDelete(action.path);
            break;
        }
        return;
      }

      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;

      const now = event.timeStamp;
      const index = nodes.findIndex((node) => node.path === focusedPath);
      const extending = now - lastKeyAtRef.current < TYPE_AHEAD_RESET_MS;
      lastKeyAtRef.current = now;
      bufferRef.current = extending ? bufferRef.current + event.key : event.key;
      // When extending, re-check the current node first (index - 1); otherwise advance past it.
      const fromIndex = extending ? index - 1 : index;
      const match = findTypeAheadMatch(nodes, bufferRef.current, fromIndex);
      if (match) {
        event.preventDefault();
        onFocus(match);
      }
    },
    [nodes, focusedPath, expandedPaths, onFocus, onExpand, onCollapse, onOpen, onToggle, onRename, onDelete],
  );
}
