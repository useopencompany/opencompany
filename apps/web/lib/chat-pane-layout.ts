/**
 * The chat workspace's split-pane layout model.
 *
 * This is the application's own layout language, not a rendering library's: a
 * plain, versioned, serializable tree that every operation transforms purely.
 * The renderer (`ChatPaneCanvas`) and the persistence layer both read it, so a
 * different renderer could replace the canvas without migrating stored layouts.
 *
 * Panes are leaves holding at most one chat id. Metadata (title, engine, run
 * state) is never stored here — it is derived from live app data, so a layout
 * restored from an earlier session can never show a stale title.
 */

export type PaneEdge = "left" | "right" | "top" | "bottom";

export type ChatPaneNode = {
  kind: "pane";
  id: string;
  /** null = an empty pane, which renders the new-chat screen. */
  chatId: string | null;
};

/**
 * A child of a split and the share of the main axis it occupies. Carrying the
 * size on the child rather than in a parallel array makes "one size per child"
 * impossible to get wrong.
 */
export type ChatSplitChild = {
  node: ChatPaneTree;
  /** Percentage of the split's main axis. Across one split these sum to 100. */
  size: number;
};

export type ChatSplitNode = {
  kind: "split";
  id: string;
  direction: "row" | "column";
  /** Always at least two children. */
  children: ChatSplitChild[];
};

export type ChatPaneTree = ChatPaneNode | ChatSplitNode;

export type ChatPaneLayout = {
  version: typeof CHAT_PANE_LAYOUT_VERSION;
  root: ChatPaneTree;
  focusedPaneId: string;
  /**
   * Monotonic source for new node ids. Keeping it in the layout makes every
   * operation deterministic and replayable instead of reaching for a global
   * counter or a random id, which also keeps SSR and hydration in agreement.
   */
  nextNodeId: number;
};

export const CHAT_PANE_LAYOUT_VERSION = 1;

/**
 * Each pane mounts a full chat Surface: an Electric subscription, a durable
 * stream, a composer, and possibly a coding workspace. Four is the point where
 * that stays affordable and a pane is still wide enough to read.
 */
export const MAX_CHAT_PANES = 4;

/** Below this a pane is too narrow to compose in, so resizing stops here. */
export const MIN_PANE_PERCENT = 15;

const EDGE_DIRECTION: Record<PaneEdge, ChatSplitNode["direction"]> = {
  left: "row",
  right: "row",
  top: "column",
  bottom: "column",
};

/** Whether the new pane lands before the pane it was dropped on. */
const EDGE_INSERTS_BEFORE: Record<PaneEdge, boolean> = {
  left: true,
  right: false,
  top: true,
  bottom: false,
};

export function createChatPaneLayout(chatId: string | null = null): ChatPaneLayout {
  return {
    version: CHAT_PANE_LAYOUT_VERSION,
    root: { kind: "pane", id: "pane-1", chatId },
    focusedPaneId: "pane-1",
    nextNodeId: 2,
  };
}

export function isPane(node: ChatPaneTree): node is ChatPaneNode {
  return node.kind === "pane";
}

export function listPanes(node: ChatPaneTree): ChatPaneNode[] {
  if (isPane(node)) return [node];
  return node.children.flatMap((child) => listPanes(child.node));
}

export function countPanes(node: ChatPaneTree): number {
  return listPanes(node).length;
}

export function findPane(node: ChatPaneTree, paneId: string): ChatPaneNode | null {
  return listPanes(node).find((pane) => pane.id === paneId) ?? null;
}

export function findPaneIdByChatId(node: ChatPaneTree, chatId: string): string | null {
  return listPanes(node).find((pane) => pane.chatId === chatId)?.id ?? null;
}

/** Chat ids currently open in some pane, in pane order. */
export function openPaneChatIds(node: ChatPaneTree): string[] {
  return listPanes(node)
    .map((pane) => pane.chatId)
    .filter((chatId): chatId is string => chatId !== null);
}

/**
 * Splits `paneId` toward `edge` and puts `chatId` in the new pane.
 *
 * A split along the same axis as the pane's parent grows that parent rather
 * than nesting inside it, so three panes side by side are three siblings with
 * independent resize handles instead of a lopsided tree.
 *
 * Returns the layout unchanged when the pane cap is already reached.
 */
export function splitPane(
  layout: ChatPaneLayout,
  paneId: string,
  edge: PaneEdge,
  chatId: string | null,
): ChatPaneLayout {
  if (countPanes(layout.root) >= MAX_CHAT_PANES) return layout;
  if (!findPane(layout.root, paneId)) return layout;

  const newPane: ChatPaneNode = { kind: "pane", id: `pane-${layout.nextNodeId}`, chatId };
  const root = insertBeside(layout.root, paneId, newPane, {
    direction: EDGE_DIRECTION[edge],
    before: EDGE_INSERTS_BEFORE[edge],
    newSplitId: `split-${layout.nextNodeId + 1}`,
  });

  return { ...layout, root, focusedPaneId: newPane.id, nextNodeId: layout.nextNodeId + 2 };
}

function insertBeside(
  node: ChatPaneTree,
  paneId: string,
  newPane: ChatPaneNode,
  options: { direction: ChatSplitNode["direction"]; before: boolean; newSplitId: string },
): ChatPaneTree {
  const { direction, before, newSplitId } = options;

  if (isPane(node)) {
    if (node.id !== paneId) return node;
    // The target is the whole subtree here, so it needs a split of its own.
    const halves: ChatSplitChild[] = before
      ? [
          { node: newPane, size: 50 },
          { node, size: 50 },
        ]
      : [
          { node, size: 50 },
          { node: newPane, size: 50 },
        ];
    return { kind: "split", id: newSplitId, direction, children: halves };
  }

  const index = node.children.findIndex((child) => isPane(child.node) && child.node.id === paneId);
  const target = index === -1 ? undefined : node.children[index];
  if (target && node.direction === direction) {
    // Same axis as this split: become a sibling and halve the target's share,
    // which leaves every other pane exactly the size it already had.
    const share = target.size / 2;
    const children = [...node.children];
    children.splice(
      index,
      1,
      ...orderedPair({ node: newPane, size: share }, { ...target, size: share }, before),
    );
    // Halving repeatedly would eventually mint a pane too narrow to compose in
    // (a third split of the same pane leaves 12.5%). When there is no room to
    // halve, the split evens out instead, which is predictable and always
    // leaves every pane usable.
    if (share < MIN_PANE_PERCENT) {
      return {
        ...node,
        children: children.map((child) => ({ ...child, size: 100 / children.length })),
      };
    }
    return { ...node, children };
  }

  return {
    ...node,
    children: node.children.map((child) => ({
      ...child,
      node: insertBeside(child.node, paneId, newPane, options),
    })),
  };
}

function orderedPair(
  incoming: ChatSplitChild,
  existing: ChatSplitChild,
  incomingFirst: boolean,
): ChatSplitChild[] {
  return incomingFirst ? [incoming, existing] : [existing, incoming];
}

/**
 * Puts `pane` along an outer edge of the whole workspace, spanning every pane
 * on that side — a full-width row beneath two chats side by side, say.
 *
 * When the root already splits along that axis the pane joins it as one more
 * sibling and the others give up space in proportion; otherwise the whole
 * existing arrangement becomes one half of a new split.
 */
function insertAtCanvasEdge(
  root: ChatPaneTree,
  pane: ChatPaneNode,
  edge: PaneEdge,
  newSplitId: string,
): ChatPaneTree {
  const direction = EDGE_DIRECTION[edge];
  const before = EDGE_INSERTS_BEFORE[edge];

  if (isPane(root) || root.direction !== direction) {
    return {
      kind: "split",
      id: newSplitId,
      direction,
      children: orderedPair({ node: pane, size: 50 }, { node: root, size: 50 }, before),
    };
  }

  const count = root.children.length + 1;
  const incoming: ChatSplitChild = { node: pane, size: 100 / count };
  const scaled = root.children.map((child) => ({
    ...child,
    size: (child.size * (count - 1)) / count,
  }));
  const children = before ? [incoming, ...scaled] : [...scaled, incoming];
  // Same rule as a same-axis pane split: never mint a pane too narrow to use.
  if (children.some((child) => child.size < MIN_PANE_PERCENT)) {
    return { ...root, children: children.map((child) => ({ ...child, size: 100 / count })) };
  }
  return { ...root, children };
}

// --- Dropping a chat --------------------------------------------------------

/**
 * Where a dragged chat will land.
 *
 * A `pane` target splits that pane toward an edge, or with `center` shows the
 * chat in the pane itself. A `canvas` target opens a pane along an outer edge
 * of the whole workspace, spanning every pane on that side.
 */
export type ChatDropTarget =
  | { kind: "pane"; paneId: string; zone: PaneEdge | "center" }
  | { kind: "canvas"; edge: PaneEdge };

/**
 * The layout after dropping `chatId` on `target`.
 *
 * The drop preview renders this same result, so what the reader sees while
 * dragging is exactly what they get on release.
 *
 * A chat that is already open is moved rather than opened twice, and its pane
 * keeps its id, so the canvas keeps its Surface mounted — transcript, scroll
 * position and any running turn — while it changes place. Moving never adds a
 * pane, so it still works at the pane cap. Opening a new chat that would
 * exceed the cap returns the layout unchanged.
 */
export function applyChatDrop(
  layout: ChatPaneLayout,
  target: ChatDropTarget,
  chatId: string,
): ChatPaneLayout {
  const openPaneId = findPaneIdByChatId(layout.root, chatId);
  if (openPaneId) return moveOpenPane(layout, openPaneId, target);

  if (target.kind === "pane") {
    return target.zone === "center"
      ? focusPane(setPaneChat(layout, target.paneId, chatId), target.paneId)
      : splitPane(layout, target.paneId, target.zone, chatId);
  }

  if (countPanes(layout.root) >= MAX_CHAT_PANES) return layout;
  const newPane: ChatPaneNode = { kind: "pane", id: `pane-${layout.nextNodeId}`, chatId };
  return {
    ...layout,
    root: insertAtCanvasEdge(layout.root, newPane, target.edge, `split-${layout.nextNodeId + 1}`),
    focusedPaneId: newPane.id,
    nextNodeId: layout.nextNodeId + 2,
  };
}

function moveOpenPane(
  layout: ChatPaneLayout,
  paneId: string,
  target: ChatDropTarget,
): ChatPaneLayout {
  const pane = findPane(layout.root, paneId);
  if (!pane) return layout;

  if (target.kind === "pane" && target.paneId === paneId) return focusPane(layout, paneId);

  const newSplitId = `split-${layout.nextNodeId}`;
  let root: ChatPaneTree;
  if (target.kind === "canvas") {
    const rest = removePane(layout.root, paneId);
    if (!rest) return layout;
    root = insertAtCanvasEdge(rest, pane, target.edge, newSplitId);
  } else if (target.zone === "center") {
    // Dropped onto another pane: the two trade places.
    const other = findPane(layout.root, target.paneId);
    if (!other) return layout;
    root = mapPanes(layout.root, (node) =>
      node.id === paneId ? other : node.id === other.id ? pane : node,
    );
  } else {
    const rest = removePane(layout.root, paneId);
    if (!rest) return layout;
    root = insertBeside(rest, target.paneId, pane, {
      direction: EDGE_DIRECTION[target.zone],
      before: EDGE_INSERTS_BEFORE[target.zone],
      newSplitId,
    });
  }
  return { ...layout, root, focusedPaneId: paneId, nextNodeId: layout.nextNodeId + 1 };
}

/**
 * The band along the workspace's outer edge, in pixels, that targets the whole
 * canvas rather than the pane beneath the pointer. Narrow enough to stay out of
 * the way of an ordinary pane split, wide enough to hit on purpose.
 */
export const CANVAS_EDGE_BAND_PX = 28;

/**
 * Half the side of the box in the middle of a pane that drops the chat into
 * the pane itself, in pane-normalized units: the middle third each way.
 */
const PANE_CENTER_HALF_EXTENT = 1 / 6;

/**
 * Resolves the drop target under a pointer.
 *
 * `point` is in canvas percentages, like the geometry; `canvasSize` is the
 * canvas in pixels, which the edge band is measured in.
 *
 * Pane edges are found by nearest edge in pane-normalized coordinates, so the
 * four regions meet at the diagonals whatever the pane's aspect ratio. Only
 * targets that change something are offered: a canvas edge only where it
 * differs from splitting the pane beneath it, and splits only while there is
 * room for another pane (moving an open chat never needs room).
 */
export function chatDropTargetAt(
  layout: ChatPaneLayout,
  geometry: PaneGeometry,
  point: { x: number; y: number },
  canvasSize: { width: number; height: number },
  chatId: string,
): ChatDropTarget | null {
  const rect = geometry.panes.find(
    (candidate) =>
      point.x >= candidate.left &&
      point.x <= candidate.left + candidate.width &&
      point.y >= candidate.top &&
      point.y <= candidate.top + candidate.height,
  );
  const pane = rect ? findPane(layout.root, rect.paneId) : null;
  if (!rect || !pane) return null;

  const openPaneId = findPaneIdByChatId(layout.root, chatId);
  const paneCount = countPanes(layout.root);
  const canPlace = openPaneId !== null || paneCount < MAX_CHAT_PANES;

  if (canPlace && paneCount > 1) {
    const edge = canvasEdgeAt(point, canvasSize);
    if (edge && !spansCanvasEdge(rect, edge)) return { kind: "canvas", edge };
  }

  // An empty pane is filled in place, the chat's own pane is already where it
  // is, and at the cap an occupied pane can still be taken over — so every
  // pane stays a valid target instead of dead-ending the drag.
  if (!pane.chatId || pane.id === openPaneId || !canPlace) {
    return { kind: "pane", paneId: pane.id, zone: "center" };
  }

  const x = (point.x - rect.left) / Math.max(Number.EPSILON, rect.width);
  const y = (point.y - rect.top) / Math.max(Number.EPSILON, rect.height);
  if (Math.abs(x - 0.5) < PANE_CENTER_HALF_EXTENT && Math.abs(y - 0.5) < PANE_CENTER_HALF_EXTENT) {
    return { kind: "pane", paneId: pane.id, zone: "center" };
  }
  const distances: [PaneEdge, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const zone = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))[0];
  return { kind: "pane", paneId: pane.id, zone };
}

function canvasEdgeAt(
  point: { x: number; y: number },
  canvasSize: { width: number; height: number },
): PaneEdge | null {
  const bandX = (CANVAS_EDGE_BAND_PX / Math.max(1, canvasSize.width)) * 100;
  const bandY = (CANVAS_EDGE_BAND_PX / Math.max(1, canvasSize.height)) * 100;
  if (point.x <= bandX) return "left";
  if (point.x >= 100 - bandX) return "right";
  if (point.y <= bandY) return "top";
  if (point.y >= 100 - bandY) return "bottom";
  return null;
}

/**
 * A pane that already runs the full length of an edge would build the same
 * arrangement from its own edge split, so the canvas target adds nothing there.
 */
function spansCanvasEdge(rect: PaneRect, edge: PaneEdge) {
  const FULL = 100 - 1e-6;
  return EDGE_DIRECTION[edge] === "row" ? rect.height >= FULL : rect.width >= FULL;
}

/**
 * Removes a pane. Its space goes back to its siblings in proportion, and a
 * split left with a single child collapses into that child.
 *
 * The last pane is never removed: it is emptied instead, which lands on the
 * new-chat screen rather than on nothing.
 */
export function closePane(layout: ChatPaneLayout, paneId: string): ChatPaneLayout {
  if (!findPane(layout.root, paneId)) return layout;

  if (countPanes(layout.root) === 1) {
    return { ...layout, root: { kind: "pane", id: paneId, chatId: null }, focusedPaneId: paneId };
  }

  const root = removePane(layout.root, paneId);
  if (!root) return layout;

  const remaining = listPanes(root);
  const focusedPaneId = remaining.some((pane) => pane.id === layout.focusedPaneId)
    ? layout.focusedPaneId
    : (remaining[0]?.id ?? layout.focusedPaneId);

  return { ...layout, root, focusedPaneId };
}

function removePane(node: ChatPaneTree, paneId: string): ChatPaneTree | null {
  if (isPane(node)) return node.id === paneId ? null : node;

  const kept: ChatSplitChild[] = [];
  for (const child of node.children) {
    const next = removePane(child.node, paneId);
    if (next) kept.push({ node: next, size: child.size });
  }

  if (kept.length === 0) return null;
  const only = kept[0];
  if (kept.length === 1 && only) return only.node;
  return { ...node, children: normalizeSizes(kept) };
}

export function setPaneChat(
  layout: ChatPaneLayout,
  paneId: string,
  chatId: string | null,
): ChatPaneLayout {
  const pane = findPane(layout.root, paneId);
  if (!pane || pane.chatId === chatId) return layout;
  return { ...layout, root: mapPane(layout.root, paneId, (node) => ({ ...node, chatId })) };
}

/** Repoints the pane showing `fromChatId` at `toChatId` (optimistic id → durable id). */
export function replacePaneChatId(
  layout: ChatPaneLayout,
  fromChatId: string,
  toChatId: string,
): ChatPaneLayout {
  if (fromChatId === toChatId) return layout;
  const paneId = findPaneIdByChatId(layout.root, fromChatId);
  if (!paneId) return layout;
  return {
    ...layout,
    root: mapPane(layout.root, paneId, (node) => ({ ...node, chatId: toChatId })),
  };
}

export function focusPane(layout: ChatPaneLayout, paneId: string): ChatPaneLayout {
  if (layout.focusedPaneId === paneId || !findPane(layout.root, paneId)) return layout;
  return { ...layout, focusedPaneId: paneId };
}

function mapPane(
  node: ChatPaneTree,
  paneId: string,
  update: (pane: ChatPaneNode) => ChatPaneNode,
): ChatPaneTree {
  if (isPane(node)) return node.id === paneId ? update(node) : node;
  return {
    ...node,
    children: node.children.map((child) => ({
      ...child,
      node: mapPane(child.node, paneId, update),
    })),
  };
}

/**
 * Moves the boundary after child `index` of a split by `deltaPercent` of the
 * split's main axis. Only the two children touching that boundary change, so a
 * drag never shuffles panes the user is not pointing at.
 */
export function resizeSplit(
  layout: ChatPaneLayout,
  splitId: string,
  index: number,
  deltaPercent: number,
): ChatPaneLayout {
  const split = findSplit(layout.root, splitId);
  const before = split?.children[index];
  const after = split?.children[index + 1];
  if (!split || !before || !after) return layout;

  const pairTotal = before.size + after.size;
  const nextBefore = clamp(
    before.size + deltaPercent,
    MIN_PANE_PERCENT,
    pairTotal - MIN_PANE_PERCENT,
  );
  if (nextBefore === before.size) return layout;

  const children = [...split.children];
  children[index] = { ...before, size: nextBefore };
  children[index + 1] = { ...after, size: pairTotal - nextBefore };
  return { ...layout, root: mapSplit(layout.root, splitId, (node) => ({ ...node, children })) };
}

function findSplit(node: ChatPaneTree, splitId: string): ChatSplitNode | null {
  if (isPane(node)) return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child.node, splitId);
    if (found) return found;
  }
  return null;
}

function mapSplit(
  node: ChatPaneTree,
  splitId: string,
  update: (split: ChatSplitNode) => ChatSplitNode,
): ChatPaneTree {
  if (isPane(node)) return node;
  if (node.id === splitId) return update(node);
  return {
    ...node,
    children: node.children.map((child) => ({
      ...child,
      node: mapSplit(child.node, splitId, update),
    })),
  };
}

function clamp(value: number, min: number, max: number) {
  // A split too small to honour both minimums (unreachable at four panes) would
  // invert the bounds, so the lower bound wins.
  return Math.max(min, Math.min(max, value));
}

function normalizeSizes(children: ChatSplitChild[]): ChatSplitChild[] {
  const total = children.reduce((sum, child) => sum + child.size, 0);
  if (total <= 0) return children.map((child) => ({ ...child, size: 100 / children.length }));
  return children.map((child) => ({ ...child, size: (child.size / total) * 100 }));
}

// --- Persistence ----------------------------------------------------------

/**
 * Rebuilds a layout from untrusted stored JSON.
 *
 * Storage is the user's own localStorage, but it is still outside input: an
 * older build or a hand-edited value can produce a tree we must not render.
 * Anything that does not normalize cleanly returns null and the caller starts
 * from a fresh single pane.
 *
 * This validates shape only. Whether a chat still exists is a question about
 * live data, so the workspace provider prunes those panes once that data has
 * arrived rather than this function guessing from a snapshot.
 */
export function parseStoredChatPaneLayout(raw: unknown): ChatPaneLayout | null {
  if (!isRecord(raw) || raw.version !== CHAT_PANE_LAYOUT_VERSION) return null;
  if (typeof raw.focusedPaneId !== "string") return null;

  const seen = { chatIds: new Set<string>(), nodeIds: new Set<string>() };
  const root = normalizeNode(raw.root, seen);
  if (!root) return null;

  const panes = listPanes(root);
  const firstPane = panes[0];
  if (!firstPane || panes.length > MAX_CHAT_PANES) return null;

  const focusedPaneId = panes.some((pane) => pane.id === raw.focusedPaneId)
    ? raw.focusedPaneId
    : firstPane.id;

  // Restart the id counter above everything in the restored tree so a new split
  // can never collide with a node that survived.
  const storedNextNodeId =
    typeof raw.nextNodeId === "number" && Number.isFinite(raw.nextNodeId) ? raw.nextNodeId : 0;

  return {
    version: CHAT_PANE_LAYOUT_VERSION,
    root,
    focusedPaneId,
    nextNodeId: Math.max(storedNextNodeId, highestNodeNumber(root) + 1),
  };
}

function normalizeNode(
  raw: unknown,
  seen: { chatIds: Set<string>; nodeIds: Set<string> },
): ChatPaneTree | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || seen.nodeIds.has(raw.id)) return null;

  if (raw.kind === "pane") {
    seen.nodeIds.add(raw.id);
    // A chat already shown in an earlier pane becomes an empty pane rather than
    // a second view of the same conversation.
    const chatId =
      typeof raw.chatId === "string" && raw.chatId !== "" && !seen.chatIds.has(raw.chatId)
        ? raw.chatId
        : null;
    if (chatId) seen.chatIds.add(chatId);
    return { kind: "pane", id: raw.id, chatId };
  }

  if (raw.kind !== "split") return null;
  if (raw.direction !== "row" && raw.direction !== "column") return null;
  if (!Array.isArray(raw.children)) return null;
  seen.nodeIds.add(raw.id);

  const children: ChatSplitChild[] = [];
  for (const rawChild of raw.children) {
    if (!isRecord(rawChild)) continue;
    const size = rawChild.size;
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) continue;
    const node = normalizeNode(rawChild.node, seen);
    if (node) children.push({ node, size });
  }

  const only = children[0];
  if (!only) return null;
  // A split that lost all but one child is just that child.
  if (children.length === 1) return only.node;
  return {
    kind: "split",
    id: raw.id,
    direction: raw.direction,
    children: normalizeSizes(children),
  };
}

function highestNodeNumber(node: ChatPaneTree): number {
  const suffix = Number.parseInt(node.id.split("-").at(-1) ?? "", 10);
  const self = Number.isFinite(suffix) ? suffix : 0;
  if (isPane(node)) return self;
  return node.children.reduce((max, child) => Math.max(max, highestNodeNumber(child.node)), self);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Restores a stored arrangement without disturbing the pane the first paint
 * already mounted.
 *
 * The first render always puts the routed chat in `mountedPaneId`, and a chat
 * Surface only adopts a different chat while it is the focused pane. So the
 * restored pane holding the routed chat takes that same id: its Surface keeps
 * the chat it already has, and every other pane mounts fresh with its own.
 * Without this, a restored pane would be told to show a chat its Surface never
 * picks up, and two panes would render the same conversation.
 */
export function restoreOntoMountedPane(
  stored: ChatPaneLayout,
  routedChatId: string | null,
  mountedPaneId: string,
): ChatPaneLayout {
  const existingPaneId = routedChatId ? findPaneIdByChatId(stored.root, routedChatId) : null;
  // A deep link to a chat the stored layout did not hold takes over its focused
  // pane, which is the one the URL already describes.
  const base = existingPaneId ? stored : setPaneChat(stored, stored.focusedPaneId, routedChatId);
  const targetPaneId = existingPaneId ?? stored.focusedPaneId;

  // Swapping two ids is a bijection, so they stay unique. When `mountedPaneId`
  // is not already in the tree the swap is one-way, which can retire the id
  // `nextNodeId` was counting from — so the counter is recomputed rather than
  // trusted, or a later split could mint an id a renamed pane already holds.
  const rename = (paneId: string) =>
    paneId === targetPaneId ? mountedPaneId : paneId === mountedPaneId ? targetPaneId : paneId;
  const root = mapPanes(base.root, (pane) => ({ ...pane, id: rename(pane.id) }));
  // The focused pane owns the URL, so focus follows the routed chat.
  return {
    ...base,
    root,
    focusedPaneId: mountedPaneId,
    nextNodeId: Math.max(base.nextNodeId, highestNodeNumber(root) + 1),
  };
}

function mapPanes(node: ChatPaneTree, update: (pane: ChatPaneNode) => ChatPaneNode): ChatPaneTree {
  if (isPane(node)) return update(node);
  return {
    ...node,
    children: node.children.map((child) => ({ ...child, node: mapPanes(child.node, update) })),
  };
}

/**
 * Makes `routedChatId` the focused chat.
 *
 * The URL and the focused pane are two views of one selection. A chat already
 * on screen is focused where it is rather than opened twice; anything else
 * takes over the focused pane.
 *
 * Idempotent: applying it to a layout that already agrees with the route
 * returns that same layout, so it is safe to run on any render.
 */
export function applyRoutedChat(
  layout: ChatPaneLayout,
  routedChatId: string | null,
): ChatPaneLayout {
  if (!routedChatId) return setPaneChat(layout, layout.focusedPaneId, null);
  const existingPaneId = findPaneIdByChatId(layout.root, routedChatId);
  if (existingPaneId) return focusPane(layout, existingPaneId);
  return setPaneChat(layout, layout.focusedPaneId, routedChatId);
}

/**
 * Closes panes holding a chat the reader can no longer open — archived,
 * deleted, or belonging to another workspace.
 *
 * `knownChatIds` null means chat data has not arrived yet, which is not the
 * same as an empty loaded workspace. The routed chat is always kept: a chat
 * opened seconds ago has not reached the live set yet.
 */
export function pruneClosedChats(
  layout: ChatPaneLayout,
  knownChatIds: ReadonlySet<string> | null,
  routedChatId: string | null,
): ChatPaneLayout {
  if (!knownChatIds) return layout;
  let next = layout;
  for (const pane of listPanes(layout.root)) {
    if (pane.chatId && pane.chatId !== routedChatId && !knownChatIds.has(pane.chatId)) {
      next = closePane(next, pane.id);
    }
  }
  return next;
}

// --- Geometry -------------------------------------------------------------

/**
 * A pane's box as percentages of the whole canvas.
 *
 * Geometry is computed rather than expressed as nested flex containers so the
 * renderer can keep every pane in one flat, stably-keyed list. Nesting panes to
 * mirror the tree would change the component type at a position whenever the
 * tree reshaped, and React would tear down the pane the reader is using — its
 * transcript subscription, scroll position and in-flight turn with it.
 */
export type PaneRect = {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

/** The draggable boundary between two children of a split. */
export type SeamRect = {
  splitId: string;
  /** Index of the child on the leading side of the boundary. */
  index: number;
  direction: ChatSplitNode["direction"];
  left: number;
  top: number;
  /** Zero along the split's main axis; the seam gets its thickness from CSS. */
  width: number;
  height: number;
  /**
   * The split's own extent along its main axis, as a percentage of the canvas.
   * Converts a pointer's pixel movement into this split's local percentages.
   */
  splitExtent: number;
};

export type PaneGeometry = { panes: PaneRect[]; seams: SeamRect[] };

export function chatPaneGeometry(root: ChatPaneTree): PaneGeometry {
  const geometry: PaneGeometry = { panes: [], seams: [] };
  collectGeometry(root, { left: 0, top: 0, width: 100, height: 100 }, geometry);
  return geometry;
}

function collectGeometry(
  node: ChatPaneTree,
  rect: Omit<PaneRect, "paneId">,
  out: PaneGeometry,
): void {
  if (isPane(node)) {
    out.panes.push({ paneId: node.id, ...rect });
    return;
  }

  const horizontal = node.direction === "row";
  const extent = horizontal ? rect.width : rect.height;
  let offset = horizontal ? rect.left : rect.top;

  node.children.forEach((child, index) => {
    const childExtent = (child.size / 100) * extent;
    collectGeometry(
      child.node,
      horizontal
        ? { left: offset, top: rect.top, width: childExtent, height: rect.height }
        : { left: rect.left, top: offset, width: rect.width, height: childExtent },
      out,
    );
    offset += childExtent;

    if (index < node.children.length - 1) {
      out.seams.push({
        splitId: node.id,
        index,
        direction: node.direction,
        left: horizontal ? offset : rect.left,
        top: horizontal ? rect.top : offset,
        width: horizontal ? 0 : rect.width,
        height: horizontal ? rect.height : 0,
        splitExtent: extent,
      });
    }
  });
}
