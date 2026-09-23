import { type ChatPaneLayout, parseStoredChatPaneLayout } from "@/lib/chat-pane-layout";

/**
 * Pane arrangements are a per-workspace view preference, so they live in
 * localStorage rather than the database: they survive a refresh, never travel
 * between workspaces, and cost nothing to write on every resize.
 *
 * Tabs deliberately do not share a layout. Two windows side by side are a
 * reasonable way to use the product, and syncing would make each one yank the
 * other's panes around.
 */
export function chatPaneLayoutKey(workspaceId: string) {
  return `opencompany:chat-panes:v1:${workspaceId}`;
}

export function readStoredChatPaneLayout(workspaceId: string): ChatPaneLayout | null {
  try {
    const raw = window.localStorage.getItem(chatPaneLayoutKey(workspaceId));
    if (!raw) return null;
    return parseStoredChatPaneLayout(JSON.parse(raw));
  } catch {
    // Blocked storage or a layout this build cannot read falls back to a single
    // pane, which is always a usable chat workspace.
    return null;
  }
}

export function persistChatPaneLayout(workspaceId: string, layout: ChatPaneLayout) {
  try {
    window.localStorage.setItem(chatPaneLayoutKey(workspaceId), JSON.stringify(layout));
  } catch {
    // Keep the live layout working when storage is blocked or its quota is full.
  }
}
