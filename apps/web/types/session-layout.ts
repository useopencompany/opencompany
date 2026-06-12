import {
  createPanel,
  isPanel,
  type LayoutNode,
  type PanelNode,
  replaceNode,
  type TabDescriptor,
} from "react-splitkit";

/**
 * Session split-layout model.
 *
 * react-splitkit's tree (`PanelNode | SplitNode`) is the single source of
 * truth. It is plain JSON, so it can later be persisted to localStorage/DB via
 * `LayoutProvider`'s `onChange` and rehydrated through `initialLayout`.
 *
 * Mapping onto the "leaf" concept: each splitkit panel is a leaf that holds at
 * most ONE session tab. A panel with zero tabs is an empty leaf and renders a
 * drop target. Splits/sizes ([50, 50] on split, re-normalized to sum 100 on
 * close) are managed by the library's reducer.
 */

export type SessionSummary = {
  id: string;
  name: string;
};

/** Stored on the session tab's `meta` — the only consumer-owned state in the tree. */
export type SessionTabMeta = {
  sessionId: string;
  sessionName: string;
};

export const SESSION_TAB_TYPE = "session";

/** DataTransfer type for sidebar → pane drags. */
export const SESSION_DRAG_MIME = "application/x-opencompany-session";

export function sessionTab(session: SessionSummary): TabDescriptor {
  return {
    id: `tab-${session.id}`,
    tabType: SESSION_TAB_TYPE,
    title: session.name,
    // Panes close via the panel header ×, not per-tab close affordances.
    closable: false,
    meta: { sessionId: session.id, sessionName: session.name } satisfies SessionTabMeta,
  };
}

export function getSessionMeta(tab: TabDescriptor | undefined): SessionTabMeta | null {
  const meta = tab?.meta as SessionTabMeta | undefined;
  return meta && typeof meta.sessionId === "string" && typeof meta.sessionName === "string"
    ? meta
    : null;
}

/** The session shown by a leaf panel (null = empty leaf / drop target). */
export function panelSession(panel: PanelNode): SessionTabMeta | null {
  const active = panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? panel.tabs[0];
  return getSessionMeta(active);
}

/** Single empty leaf — the initial single-pane layout. */
export function createEmptyLayout(): LayoutNode {
  return createPanel("panel-root", []);
}

/** Single leaf already holding a session — initial layout for a routed session page. */
export function createSessionLayout(session: SessionSummary): LayoutNode {
  return createPanel("panel-root", [sessionTab(session)]);
}

/** Id of the first (leftmost/topmost) leaf panel. */
export function firstPanelId(node: LayoutNode): string | null {
  if (isPanel(node)) return node.id;
  for (const child of node.children) {
    const found = firstPanelId(child);
    if (found) return found;
  }
  return null;
}

/**
 * Returns a new tree where `panelId`'s leaf shows `session` instead of its
 * current content (splits/sizes untouched). Used to sync the routed session
 * into the layout without disturbing the pane arrangement.
 */
export function replacePanelSession(
  node: LayoutNode,
  panelId: string,
  session: SessionSummary,
): LayoutNode | null {
  const found = findPanelNode(node, panelId);
  if (!found) return null;
  const tab = sessionTab(session);
  return replaceNode(node, panelId, { ...found, tabs: [tab], activeTabId: tab.id });
}

function findPanelNode(node: LayoutNode, panelId: string): PanelNode | null {
  if (isPanel(node)) return node.id === panelId ? node : null;
  for (const child of node.children) {
    const found = findPanelNode(child, panelId);
    if (found) return found;
  }
  return null;
}

export function countPanes(node: LayoutNode): number {
  if (isPanel(node)) return 1;
  return node.children.reduce((sum, child) => sum + countPanes(child), 0);
}

/** Find the leaf panel currently showing `sessionId`, if any. */
export function findPanelIdBySessionId(node: LayoutNode, sessionId: string): string | null {
  if (isPanel(node)) {
    return panelSession(node)?.sessionId === sessionId ? node.id : null;
  }
  for (const child of node.children) {
    const found = findPanelIdBySessionId(child, sessionId);
    if (found) return found;
  }
  return null;
}

/** All session ids currently open in a pane. */
export function openSessionIds(node: LayoutNode): Set<string> {
  const ids = new Set<string>();
  const walk = (current: LayoutNode) => {
    if (isPanel(current)) {
      const session = panelSession(current);
      if (session) ids.add(session.sessionId);
      return;
    }
    for (const child of current.children) walk(child);
  };
  walk(node);
  return ids;
}

// --- Native HTML5 DnD payload helpers -------------------------------------

export function writeSessionDragPayload(dataTransfer: DataTransfer, session: SessionSummary) {
  dataTransfer.setData(
    SESSION_DRAG_MIME,
    JSON.stringify({ sessionId: session.id, sessionName: session.name } satisfies SessionTabMeta),
  );
  // Fallback so dropping outside the app pastes something sensible.
  dataTransfer.setData("text/plain", session.name);
  dataTransfer.effectAllowed = "copy";
}

/**
 * Whether an in-flight drag is one of our session drags. During `dragover`
 * only `types` is readable (the payload itself is protected until `drop`).
 */
export function isSessionDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(SESSION_DRAG_MIME);
}

export function readSessionDragPayload(dataTransfer: DataTransfer): SessionTabMeta | null {
  try {
    const raw = dataTransfer.getData(SESSION_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionTabMeta>;
    if (typeof parsed.sessionId !== "string" || typeof parsed.sessionName !== "string") {
      return null;
    }
    return { sessionId: parsed.sessionId, sessionName: parsed.sessionName };
  } catch {
    return null;
  }
}
