import { describe, expect, it, vi } from "vitest";
import {
  availableWikiSlug,
  buildTree,
  loadWikiTreeExpandedFolderIds,
  persistWikiTreeExpandedFolderIds,
  type WikiPageData,
} from "./WikiView";

function node(overrides: Partial<WikiPageData>): WikiPageData {
  return {
    id: overrides.path ?? "node",
    slug: "node",
    path: "node",
    title: "Node",
    nodeType: "page",
    kind: "other",
    body: "",
    ...overrides,
  };
}

describe("Wiki tree helpers", () => {
  it("deduplicates slugs within a folder only", () => {
    const pages = [
      node({ path: "company/goals", slug: "goals" }),
      node({ path: "company/goals-2", slug: "goals-2" }),
    ];
    expect(availableWikiSlug("Goals", pages, "company")).toBe("goals-3");
    expect(availableWikiSlug("Goals", pages, "personal")).toBe("goals");
  });

  it("does not treat the renamed node's existing slug as a collision", () => {
    const pages = [node({ id: "page-a", path: "company/goals", slug: "goals" })];
    expect(availableWikiSlug("Goals", pages, "company", "page-a")).toBe("goals");
  });

  it("sorts folders first and then pages by display title", () => {
    const tree = buildTree([
      node({ id: "page-a", path: "a", slug: "a", title: "Alpha" }),
      node({ id: "folder-z", path: "z", slug: "z", title: "Zulu", nodeType: "folder" }),
      node({ id: "folder-b", path: "b", slug: "b", title: "Beta", nodeType: "folder" }),
      node({ id: "page-c", path: "c", slug: "c", title: "Charlie" }),
    ]);
    expect(tree.map((entry) => entry.id)).toEqual(["folder-b", "folder-z", "page-a", "page-c"]);
  });

  it("starts with every folder collapsed when no expansion preference exists", () => {
    const storage = memoryStorage();
    expect(loadWikiTreeExpandedFolderIds(storage, "user-1", "workspace-1")).toEqual(new Set());
  });

  it("remembers expanded folders per user and workspace", () => {
    const storage = memoryStorage();
    persistWikiTreeExpandedFolderIds(
      storage,
      "user-1",
      "workspace-1",
      new Set(["folder-b", "folder-a"]),
    );

    expect(loadWikiTreeExpandedFolderIds(storage, "user-1", "workspace-1")).toEqual(
      new Set(["folder-a", "folder-b"]),
    );
    expect(loadWikiTreeExpandedFolderIds(storage, "user-2", "workspace-1")).toEqual(new Set());
    expect(loadWikiTreeExpandedFolderIds(storage, "user-1", "workspace-2")).toEqual(new Set());
  });

  it("ignores an invalid stored expansion preference", () => {
    const storage = memoryStorage();
    storage.setItem("opencompany-wiki-tree-expanded:v1:user-1:workspace-1", "not-json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadWikiTreeExpandedFolderIds(storage, "user-1", "workspace-1")).toEqual(new Set());
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("keeps the tree usable when browser storage is unavailable", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(loadWikiTreeExpandedFolderIds(unavailableStorage, "user-1", "workspace-1")).toEqual(
      new Set(),
    );
    expect(() =>
      persistWikiTreeExpandedFolderIds(
        unavailableStorage,
        "user-1",
        "workspace-1",
        new Set(["folder-a"]),
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}
