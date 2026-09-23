import { describe, expect, it } from "vitest";
import {
  applyRoutedChat,
  CHAT_PANE_LAYOUT_VERSION,
  type ChatPaneLayout,
  type ChatPaneTree,
  chatPaneGeometry,
  closePane,
  countPanes,
  createChatPaneLayout,
  findPane,
  findPaneIdByChatId,
  focusPane,
  isPane,
  listPanes,
  MAX_CHAT_PANES,
  MIN_PANE_PERCENT,
  openPaneChatIds,
  parseStoredChatPaneLayout,
  pruneClosedChats,
  replacePaneChatId,
  resizeSplit,
  restoreOntoMountedPane,
  setPaneChat,
  splitPane,
} from "@/lib/chat-pane-layout";

function paneIdFor(layout: ChatPaneLayout, chatId: string) {
  const paneId = findPaneIdByChatId(layout.root, chatId);
  if (!paneId) throw new Error(`No pane holds ${chatId}`);
  return paneId;
}

function splitOf(node: ChatPaneTree) {
  if (isPane(node)) throw new Error("Expected a split at this position");
  return node;
}

/** Every split's shares must still describe a whole, or the renderer drifts. */
function expectSizesSumTo100(node: ChatPaneTree) {
  if (isPane(node)) return;
  const total = node.children.reduce((sum, child) => sum + child.size, 0);
  expect(total).toBeCloseTo(100, 6);
  for (const child of node.children) expectSizesSumTo100(child.node);
}

describe("chat pane layout", () => {
  it("starts as one pane holding the routed chat", () => {
    const layout = createChatPaneLayout("chat_a");
    expect(countPanes(layout.root)).toBe(1);
    expect(openPaneChatIds(layout.root)).toEqual(["chat_a"]);
    expect(layout.focusedPaneId).toBe("pane-1");
  });

  describe("splitting", () => {
    it("splits a pane toward an edge and focuses the new pane", () => {
      const layout = createChatPaneLayout("chat_a");
      const next = splitPane(layout, "pane-1", "right", "chat_b");

      const root = splitOf(next.root);
      expect(root.direction).toBe("row");
      expect(root.children.map((child) => (isPane(child.node) ? child.node.chatId : null))).toEqual(
        ["chat_a", "chat_b"],
      );
      expect(next.focusedPaneId).toBe(paneIdFor(next, "chat_b"));
      expectSizesSumTo100(next.root);
    });

    it("puts the new pane first when splitting toward left or top", () => {
      const left = splitPane(createChatPaneLayout("chat_a"), "pane-1", "left", "chat_b");
      expect(openPaneChatIds(left.root)).toEqual(["chat_b", "chat_a"]);

      const top = splitPane(createChatPaneLayout("chat_a"), "pane-1", "top", "chat_b");
      expect(splitOf(top.root).direction).toBe("column");
      expect(openPaneChatIds(top.root)).toEqual(["chat_b", "chat_a"]);
    });

    it("grows the parent split instead of nesting when the axis matches", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "right", "chat_c");

      const root = splitOf(layout.root);
      expect(root.children).toHaveLength(3);
      expect(root.children.every((child) => isPane(child.node))).toBe(true);
      expect(openPaneChatIds(layout.root)).toEqual(["chat_a", "chat_b", "chat_c"]);
      expectSizesSumTo100(layout.root);
    });

    it("takes the split's share only from the pane being split", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "right", "chat_c");

      // chat_a keeps its half; chat_b's half is what gets divided.
      expect(splitOf(layout.root).children.map((child) => child.size)).toEqual([50, 25, 25]);
    });

    it("nests a new split when the axis differs from the parent", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "bottom", "chat_c");

      const root = splitOf(layout.root);
      expect(root.direction).toBe("row");
      expect(root.children).toHaveLength(2);
      const nested = splitOf(root.children[1]?.node as ChatPaneTree);
      expect(nested.direction).toBe("column");
      expect(openPaneChatIds(layout.root)).toEqual(["chat_a", "chat_b", "chat_c"]);
      expectSizesSumTo100(layout.root);
    });

    it("refuses to open a fifth pane", () => {
      let layout = createChatPaneLayout("chat_1");
      for (const chatId of ["chat_2", "chat_3", "chat_4"]) {
        layout = splitPane(layout, layout.focusedPaneId, "right", chatId);
      }
      expect(countPanes(layout.root)).toBe(MAX_CHAT_PANES);

      const capped = splitPane(layout, layout.focusedPaneId, "right", "chat_5");
      expect(capped).toBe(layout);
    });

    it("ignores a split of a pane that is not in the tree", () => {
      const layout = createChatPaneLayout("chat_a");
      expect(splitPane(layout, "pane-404", "right", "chat_b")).toBe(layout);
    });
  });

  describe("closing", () => {
    it("gives the closed pane's space back to its siblings and collapses the split", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      const closed = closePane(layout, paneIdFor(layout, "chat_b"));

      expect(isPane(closed.root)).toBe(true);
      expect(openPaneChatIds(closed.root)).toEqual(["chat_a"]);
      expect(closed.focusedPaneId).toBe(paneIdFor(closed, "chat_a"));
    });

    it("rescales the remaining siblings back to a whole", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "right", "chat_c");
      const closed = closePane(layout, paneIdFor(layout, "chat_a"));

      expect(countPanes(closed.root)).toBe(2);
      expectSizesSumTo100(closed.root);
    });

    it("empties the last pane rather than leaving nothing on screen", () => {
      const layout = createChatPaneLayout("chat_a");
      const closed = closePane(layout, "pane-1");

      expect(countPanes(closed.root)).toBe(1);
      expect(openPaneChatIds(closed.root)).toEqual([]);
      expect(closed.focusedPaneId).toBe("pane-1");
    });

    it("keeps focus when a pane other than the focused one closes", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      const focusedPaneId = layout.focusedPaneId;
      const closed = closePane(layout, paneIdFor(layout, "chat_a"));

      expect(closed.focusedPaneId).toBe(focusedPaneId);
    });
  });

  describe("chat assignment", () => {
    it("repoints a pane when an optimistic chat id resolves to its durable id", () => {
      const layout = createChatPaneLayout("optimistic_1");
      const resolved = replacePaneChatId(layout, "optimistic_1", "chat_durable");

      expect(openPaneChatIds(resolved.root)).toEqual(["chat_durable"]);
    });

    it("leaves the layout alone when the optimistic chat is no longer open", () => {
      const layout = createChatPaneLayout("chat_a");
      expect(replacePaneChatId(layout, "optimistic_1", "chat_durable")).toBe(layout);
    });

    it("returns the same layout when nothing changes", () => {
      const layout = createChatPaneLayout("chat_a");
      expect(setPaneChat(layout, "pane-1", "chat_a")).toBe(layout);
      expect(focusPane(layout, "pane-1")).toBe(layout);
      expect(focusPane(layout, "pane-404")).toBe(layout);
    });
  });

  describe("resizing", () => {
    function twoPaneLayout() {
      const layout = splitPane(createChatPaneLayout("chat_a"), "pane-1", "right", "chat_b");
      return { layout, splitId: splitOf(layout.root).id };
    }

    it("moves only the two panes touching the boundary", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "right", "chat_c");
      const splitId = splitOf(layout.root).id;

      const resized = resizeSplit(layout, splitId, 1, 10);
      expect(splitOf(resized.root).children.map((child) => child.size)).toEqual([50, 35, 15]);
      expectSizesSumTo100(resized.root);
    });

    it("stops at the minimum pane size in both directions", () => {
      const { layout, splitId } = twoPaneLayout();

      const shrunk = resizeSplit(layout, splitId, 0, -1000);
      expect(splitOf(shrunk.root).children.map((child) => child.size)).toEqual([
        MIN_PANE_PERCENT,
        100 - MIN_PANE_PERCENT,
      ]);

      const grown = resizeSplit(layout, splitId, 0, 1000);
      expect(splitOf(grown.root).children.map((child) => child.size)).toEqual([
        100 - MIN_PANE_PERCENT,
        MIN_PANE_PERCENT,
      ]);
    });

    it("ignores a boundary that does not exist", () => {
      const { layout, splitId } = twoPaneLayout();
      expect(resizeSplit(layout, splitId, 1, 10)).toBe(layout);
      expect(resizeSplit(layout, splitId, -1, 10)).toBe(layout);
      expect(resizeSplit(layout, "split-404", 0, 10)).toBe(layout);
    });
  });

  describe("restoring a stored layout", () => {
    function roundTrip(layout: ChatPaneLayout) {
      return parseStoredChatPaneLayout(JSON.parse(JSON.stringify(layout)));
    }

    it("round-trips a split layout unchanged", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "bottom", "chat_c");

      expect(roundTrip(layout)).toEqual(layout);
    });

    it("rejects a layout from an unknown version", () => {
      const layout = { ...createChatPaneLayout("chat_a"), version: 99 };
      expect(parseStoredChatPaneLayout(layout)).toBeNull();
    });

    it("rejects values that are not a layout at all", () => {
      expect(parseStoredChatPaneLayout(null)).toBeNull();
      expect(parseStoredChatPaneLayout("{}")).toBeNull();
      expect(parseStoredChatPaneLayout({ version: CHAT_PANE_LAYOUT_VERSION })).toBeNull();
    });

    it("empties the later pane when a chat is stored twice", () => {
      const restored = parseStoredChatPaneLayout({
        version: CHAT_PANE_LAYOUT_VERSION,
        focusedPaneId: "pane-1",
        nextNodeId: 4,
        root: {
          kind: "split",
          id: "split-3",
          direction: "row",
          children: [
            { size: 50, node: { kind: "pane", id: "pane-1", chatId: "chat_a" } },
            { size: 50, node: { kind: "pane", id: "pane-2", chatId: "chat_a" } },
          ],
        },
      });

      expect(restored).not.toBeNull();
      expect(openPaneChatIds(restored?.root as ChatPaneTree)).toEqual(["chat_a"]);
      expect(countPanes(restored?.root as ChatPaneTree)).toBe(2);
    });

    it("collapses a split whose children did not survive validation", () => {
      const restored = parseStoredChatPaneLayout({
        version: CHAT_PANE_LAYOUT_VERSION,
        focusedPaneId: "pane-1",
        nextNodeId: 4,
        root: {
          kind: "split",
          id: "split-3",
          direction: "row",
          children: [
            { size: 50, node: { kind: "pane", id: "pane-1", chatId: "chat_a" } },
            { size: 50, node: { kind: "elsewhere", id: "pane-2" } },
          ],
        },
      });

      expect(restored?.root).toEqual({ kind: "pane", id: "pane-1", chatId: "chat_a" });
    });

    it("rejects a stored layout over the pane cap", () => {
      let layout = createChatPaneLayout("chat_1");
      for (const chatId of ["chat_2", "chat_3", "chat_4"]) {
        layout = splitPane(layout, layout.focusedPaneId, "right", chatId);
      }
      const root = splitOf(layout.root);
      const overCapacity = {
        ...layout,
        root: {
          ...root,
          children: [
            ...root.children,
            { size: 20, node: { kind: "pane", id: "pane-99", chatId: "chat_5" } },
          ],
        },
      };

      expect(parseStoredChatPaneLayout(overCapacity)).toBeNull();
    });

    it("falls back to the first pane when the stored focus is gone", () => {
      const layout = createChatPaneLayout("chat_a");
      const restored = parseStoredChatPaneLayout({ ...layout, focusedPaneId: "pane-404" });
      expect(restored?.focusedPaneId).toBe("pane-1");
    });

    it("restarts the id counter above every restored node", () => {
      const layout = splitPane(createChatPaneLayout("chat_a"), "pane-1", "right", "chat_b");
      const restored = parseStoredChatPaneLayout({ ...layout, nextNodeId: 0 });

      expect(restored).not.toBeNull();
      const restoredLayout = restored as ChatPaneLayout;
      const grown = splitPane(restoredLayout, restoredLayout.focusedPaneId, "bottom", "chat_c");
      const ids = listPanes(grown.root).map((pane) => pane.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("rescales stored sizes that do not sum to a whole", () => {
      const layout = splitPane(createChatPaneLayout("chat_a"), "pane-1", "right", "chat_b");
      const root = splitOf(layout.root);
      const restored = parseStoredChatPaneLayout({
        ...layout,
        root: {
          ...root,
          children: root.children.map((child) => ({ ...child, size: 10 })),
        },
      });

      expect(restored).not.toBeNull();
      expectSizesSumTo100(restored?.root as ChatPaneTree);
    });
  });

  describe("geometry", () => {
    it("gives a lone pane the whole canvas and no seams", () => {
      const geometry = chatPaneGeometry(createChatPaneLayout("chat_a").root);
      expect(geometry.panes).toEqual([
        { paneId: "pane-1", left: 0, top: 0, width: 100, height: 100 },
      ]);
      expect(geometry.seams).toEqual([]);
    });

    it("lays a row split out side by side with a seam on the boundary", () => {
      const layout = splitPane(createChatPaneLayout("chat_a"), "pane-1", "right", "chat_b");
      const geometry = chatPaneGeometry(layout.root);

      expect(geometry.panes).toEqual([
        { paneId: "pane-1", left: 0, top: 0, width: 50, height: 100 },
        { paneId: "pane-2", left: 50, top: 0, width: 50, height: 100 },
      ]);
      expect(geometry.seams).toEqual([
        {
          splitId: splitOf(layout.root).id,
          index: 0,
          direction: "row",
          left: 50,
          top: 0,
          width: 0,
          height: 100,
          splitExtent: 100,
        },
      ]);
    });

    it("scopes a nested split to its parent's box", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "bottom", "chat_c");
      const geometry = chatPaneGeometry(layout.root);

      // The nested column only divides the right-hand half.
      expect(geometry.panes).toEqual([
        { paneId: "pane-1", left: 0, top: 0, width: 50, height: 100 },
        { paneId: "pane-2", left: 50, top: 0, width: 50, height: 50 },
        { paneId: "pane-4", left: 50, top: 50, width: 50, height: 50 },
      ]);

      const nestedSeam = geometry.seams.find((seam) => seam.direction === "column");
      // A seam inside a half-height box converts pointer pixels against that
      // box, not the whole canvas.
      expect(nestedSeam).toMatchObject({
        left: 50,
        top: 50,
        width: 50,
        height: 0,
        splitExtent: 100,
      });
    });

    it("keeps panes tiling the canvas after a resize", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = resizeSplit(layout, splitOf(layout.root).id, 0, 20);
      const geometry = chatPaneGeometry(layout.root);

      const right = geometry.panes[1];
      expect(geometry.panes[0]).toMatchObject({ left: 0, width: 70 });
      expect(right).toMatchObject({ left: 70, width: 30 });
      expect((right?.left ?? 0) + (right?.width ?? 0)).toBeCloseTo(100, 6);
    });
  });

  describe("restoring onto the pane the first paint mounted", () => {
    function storedThreePaneLayout() {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "bottom", "chat_c");
      return layout;
    }

    it("gives the mounted pane's id to the pane holding the routed chat", () => {
      const stored = storedThreePaneLayout();
      const restored = restoreOntoMountedPane(stored, "chat_c", "pane-1");

      // The Surface already mounted as `pane-1` is showing chat_c, so `pane-1`
      // must be the pane that holds chat_c after the restore.
      expect(findPaneIdByChatId(restored.root, "chat_c")).toBe("pane-1");
      expect(restored.focusedPaneId).toBe("pane-1");
      // The arrangement itself is unchanged: same panes, same chats.
      expect(openPaneChatIds(restored.root).sort()).toEqual(["chat_a", "chat_b", "chat_c"]);
      expect(countPanes(restored.root)).toBe(3);
    });

    it("keeps every pane id unique after the swap", () => {
      const restored = restoreOntoMountedPane(storedThreePaneLayout(), "chat_c", "pane-1");
      const ids = listPanes(restored.root).map((pane) => pane.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("leaves the tree alone when the routed chat is already in the mounted pane", () => {
      const stored = storedThreePaneLayout();
      const restored = restoreOntoMountedPane(stored, "chat_a", "pane-1");

      expect(findPaneIdByChatId(restored.root, "chat_a")).toBe("pane-1");
      expect(restored.root).toEqual(stored.root);
    });

    it("takes over the stored focused pane for a chat the layout did not hold", () => {
      const stored = storedThreePaneLayout();
      const restored = restoreOntoMountedPane(stored, "chat_new", "pane-1");

      expect(findPaneIdByChatId(restored.root, "chat_new")).toBe("pane-1");
      expect(countPanes(restored.root)).toBe(3);
      // The chat that pane held is replaced, not duplicated elsewhere.
      expect(openPaneChatIds(restored.root)).not.toContain("chat_c");
    });

    it("empties the mounted pane when the route is Home", () => {
      const restored = restoreOntoMountedPane(storedThreePaneLayout(), null, "pane-1");
      expect(findPane(restored.root, "pane-1")?.chatId).toBeNull();
      expect(restored.focusedPaneId).toBe("pane-1");
    });
  });

  describe("following the route", () => {
    function threePanes() {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "bottom", "chat_c");
      return layout;
    }

    it("focuses the pane already showing the routed chat", () => {
      const layout = focusPane(threePanes(), "pane-1");
      const routed = applyRoutedChat(layout, "chat_c");

      expect(routed.focusedPaneId).toBe(paneIdFor(layout, "chat_c"));
      expect(countPanes(routed.root)).toBe(3);
    });

    it("opens a chat that is not on screen in the focused pane", () => {
      const layout = focusPane(threePanes(), "pane-1");
      const routed = applyRoutedChat(layout, "chat_new");

      expect(findPane(routed.root, "pane-1")?.chatId).toBe("chat_new");
      expect(openPaneChatIds(routed.root)).not.toContain("chat_a");
    });

    it("is idempotent once the layout agrees with the route", () => {
      const layout = applyRoutedChat(threePanes(), "chat_c");
      // Re-running on every render must not fight a focus change.
      expect(applyRoutedChat(layout, "chat_c")).toBe(layout);
    });

    it("empties the focused pane on the Home route", () => {
      const layout = focusPane(threePanes(), "pane-1");
      expect(findPane(applyRoutedChat(layout, null).root, "pane-1")?.chatId).toBeNull();
    });
  });

  describe("pruning chats the reader can no longer open", () => {
    function twoPanes() {
      return splitPane(createChatPaneLayout("chat_a"), "pane-1", "right", "chat_b");
    }

    it("closes the pane whose chat is gone", () => {
      const pruned = pruneClosedChats(twoPanes(), new Set(["chat_a"]), null);

      expect(countPanes(pruned.root)).toBe(1);
      expect(openPaneChatIds(pruned.root)).toEqual(["chat_a"]);
    });

    it("waits for live chat data instead of closing everything", () => {
      const layout = twoPanes();
      // An empty set means "not loaded yet", not "no chats exist".
      expect(pruneClosedChats(layout, new Set(), null)).toBe(layout);
    });

    it("keeps the routed chat, which may still be optimistic", () => {
      const layout = twoPanes();
      const pruned = pruneClosedChats(layout, new Set(["chat_a"]), "chat_b");

      expect(pruned).toBe(layout);
      expect(openPaneChatIds(pruned.root)).toEqual(["chat_a", "chat_b"]);
    });

    it("empties the last pane rather than leaving nothing", () => {
      const pruned = pruneClosedChats(createChatPaneLayout("chat_gone"), new Set(["chat_a"]), null);

      expect(countPanes(pruned.root)).toBe(1);
      expect(openPaneChatIds(pruned.root)).toEqual([]);
    });
  });

  describe("keeping every pane usable", () => {
    it("evens the split out rather than minting a pane below the minimum", () => {
      let layout = createChatPaneLayout("chat_a");
      layout = splitPane(layout, "pane-1", "right", "chat_b");
      layout = splitPane(layout, paneIdFor(layout, "chat_b"), "right", "chat_c");
      // A third same-axis split of the 25% pane would leave 12.5%.
      layout = splitPane(layout, paneIdFor(layout, "chat_c"), "right", "chat_d");

      const sizes = splitOf(layout.root).children.map((child) => child.size);
      expect(sizes).toEqual([25, 25, 25, 25]);
      for (const size of sizes) expect(size).toBeGreaterThanOrEqual(MIN_PANE_PERCENT);
      expectSizesSumTo100(layout.root);
    });

    it("keeps a restored layout's id counter above every pane it renamed", () => {
      let stored = createChatPaneLayout("chat_a");
      stored = splitPane(stored, "pane-1", "right", "chat_b");
      // A workspace switch restores onto whatever pane the previous workspace
      // had focused, which can be an id this tree never used.
      const restored = restoreOntoMountedPane(stored, "chat_b", "pane-12");

      const grown = splitPane(restored, restored.focusedPaneId, "bottom", "chat_c");
      const ids = listPanes(grown.root).map((pane) => pane.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain("pane-12");
    });
  });
});
