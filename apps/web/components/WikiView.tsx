"use client";

// The wiki surface: an Obsidian-style tree of folders and leaf markdown pages.
//
// Local-first: the tree, page bodies, and timelines are Electric-synced
// TanStack DB collections (see lib/headless-knowledge-collections.ts). Every mutation is
// applied optimistically — a rename is visible in the sidebar and in every
// [[link]] chip on the same keystroke — and persisted through the same server
// actions/storage layer the `wiki` agent tool uses, with Postgres txids
// holding optimistic state exactly until the write streams back. The server
// ships one initial payload for first paint; the live collections take over
// as soon as the shape syncs. Navigation is pure client state via
// history.pushState.

import {
  movedWikiPath,
  parentWikiPath,
  WIKI_KINDS,
  type WikiKind,
  wikiPageLinkTargets,
  wikiSlugFromTitle,
} from "@opencompany/wiki";
import { debounceStrategy, useLiveQuery, usePacedMutations } from "@tanstack/react-db";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  DatabaseZap,
  History,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MarkdownBrainEditor } from "@/components/MarkdownBrainEditor";
import {
  asHeadlessWikiPageWriteMutations,
  getHeadlessWikiCollections,
  type HeadlessWikiCollections,
  type HeadlessWikiPageReadModel,
  persistHeadlessWikiPageWrites,
} from "@/lib/headless-knowledge-collections";

export type WikiPageData = {
  id: string;
  slug: string;
  path: string;
  title: string;
  nodeType: "page" | "folder";
  kind: WikiKind;
  body: string;
};

export type TreeNode = WikiPageData & { children: TreeNode[] };

const SAVE_DEBOUNCE_MS = 500;
const WIKI_TREE_EXPANSION_STORAGE_PREFIX = "opencompany-wiki-tree-expanded:v1";

type WikiTreeExpansionStorage = Pick<Storage, "getItem" | "setItem">;

function wikiTreeExpansionStorageKey(userWorkosId: string, workspaceId: string) {
  return `${WIKI_TREE_EXPANSION_STORAGE_PREFIX}:${userWorkosId}:${workspaceId}`;
}

export function loadWikiTreeExpandedFolderIds(
  storage: WikiTreeExpansionStorage,
  userWorkosId: string,
  workspaceId: string,
) {
  try {
    const stored = storage.getItem(wikiTreeExpansionStorageKey(userWorkosId, workspaceId));
    if (!stored) return new Set<string>();
    const value: unknown = JSON.parse(stored);
    if (!Array.isArray(value)) return new Set<string>();
    return new Set(value.filter((entry): entry is string => typeof entry === "string"));
  } catch (error) {
    console.warn("[opencompany] Could not read the wiki tree expansion preference", error);
    return new Set<string>();
  }
}

export function persistWikiTreeExpandedFolderIds(
  storage: WikiTreeExpansionStorage,
  userWorkosId: string,
  workspaceId: string,
  expandedFolderIds: ReadonlySet<string>,
) {
  try {
    storage.setItem(
      wikiTreeExpansionStorageKey(userWorkosId, workspaceId),
      JSON.stringify([...expandedFolderIds].toSorted()),
    );
  } catch (error) {
    console.warn("[opencompany] Could not save the wiki tree expansion preference", error);
  }
}

const subscribeToHydration = () => () => undefined;
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;

// TanStack DB has no server snapshot for useLiveQuery and Electric collections
// must never sync server-side, so the live view mounts post-hydration; the
// server payload paints a read-only frame for the first client render.
export function WikiView(props: {
  userWorkosId: string;
  workspaceId: string;
  pages: WikiPageData[];
  initialPath: string | null;
}) {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot,
  );
  if (!hydrated) return <WikiStaticFrame pages={props.pages} initialPath={props.initialPath} />;
  return <WikiLiveView {...props} />;
}

function WikiStaticFrame({
  pages,
  initialPath,
}: {
  pages: WikiPageData[];
  initialPath: string | null;
}) {
  const nodes = buildTree(pages);
  const page = initialPath
    ? (pages.find((entry) => entry.nodeType === "page" && entry.path === initialPath) ?? null)
    : null;
  const noop = () => undefined;
  return (
    <div className="flex h-full min-h-0 w-full">
      <WikiTreeSidebar
        nodes={nodes}
        selectedPath={initialPath}
        onSelect={noop}
        onCreate={() => null}
        onRename={noop}
        onDelete={noop}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {page ? (
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-5">
            <input
              value={page.title}
              readOnly
              placeholder="Untitled"
              className="mt-3 w-full bg-transparent text-[26px] font-semibold leading-8 text-ink outline-none placeholder:text-ink-subtle/50"
            />
            <div className="mt-4 flex-1">
              <MarkdownBrainEditor content={page.body} onChange={noop} readOnly />
            </div>
          </div>
        ) : (
          <WikiEmptyState
            hasPages={pages.some((entry) => entry.nodeType === "page")}
            onCreate={noop}
          />
        )}
      </div>
    </div>
  );
}

function WikiLiveView({
  userWorkosId,
  workspaceId,
  pages: initialPages,
  initialPath,
}: {
  userWorkosId: string;
  workspaceId: string;
  pages: WikiPageData[];
  initialPath: string | null;
}) {
  const pathname = usePathname();
  const [error, setError] = useState<string | null>(null);
  const collections = useMemo(() => getHeadlessWikiCollections(workspaceId), [workspaceId]);

  const { data: pageRows, isLoading: pagesLoading } = useLiveQuery(
    (q) => q.from({ page: collections.pages }),
    [collections],
  );
  const { data: timelineRows } = useLiveQuery(
    (q) => q.from({ entry: collections.timeline }),
    [collections],
  );

  // Until the shape has synced once, render the server payload; mutations are
  // deferred because they need the collection rows to exist.
  const syncReady = !pagesLoading;
  const pages: WikiPageData[] = useMemo(() => {
    if (!syncReady) return initialPages;
    return ((pageRows ?? []) as HeadlessWikiPageReadModel[]).map(pageRowToData);
  }, [initialPages, pageRows, syncReady]);

  const timelineCountByPageId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of timelineRows ?? []) {
      counts.set(row.pageId, (counts.get(row.pageId) ?? 0) + 1);
    }
    return counts;
  }, [timelineRows]);

  const selectedPath = useMemo(() => {
    const fromUrl = pathname.replace(/^\/wiki\/?/, "");
    return fromUrl ? decodeURIComponent(fromUrl) : (initialPath ?? null);
  }, [pathname, initialPath]);

  const navigate = useCallback((path: string | null) => {
    window.history.pushState(null, "", path ? `/wiki/${path}` : "/wiki");
  }, []);

  const nodes = useMemo(() => buildTree(pages), [pages]);
  const wikiLinks = useMemo(
    () =>
      Object.fromEntries(
        pages
          .filter((page) => page.nodeType === "page")
          .map((page) => [page.path, `/wiki/${page.path}`]),
      ),
    [pages],
  );
  const pageTitles = useMemo(
    () =>
      Object.fromEntries(
        pages
          .filter((page) => page.nodeType === "page")
          .map((page) => [page.path, page.title || "Untitled"]),
      ),
    [pages],
  );
  const backlinksByPath = useMemo(() => {
    const index = new Map<string, Array<{ path: string; title: string }>>();
    for (const page of pages) {
      if (page.nodeType !== "page") continue;
      for (const target of wikiPageLinkTargets(page.body)) {
        const existing = index.get(target);
        const entry = { path: page.path, title: page.title };
        if (existing) existing.push(entry);
        else index.set(target, [entry]);
      }
    }
    return index;
  }, [pages]);

  const page = selectedPath
    ? (pages.find((entry) => entry.nodeType === "page" && entry.path === selectedPath) ?? null)
    : null;

  const surfaceError = useCallback((message: string | undefined) => {
    setError(message ?? "Something went wrong.");
    window.setTimeout(() => setError(null), 6_000);
  }, []);

  const trackPersistence = useCallback(
    (tx: { isPersisted: { promise: Promise<unknown> } }) => {
      tx.isPersisted.promise.catch((cause: unknown) =>
        surfaceError(cause instanceof Error ? cause.message : undefined),
      );
    },
    [surfaceError],
  );

  // Pages created this session whose title the editor should focus, so a new
  // page lands ready to name — the Notion flow.
  const focusTitlePageIdRef = useRef<string | null>(null);

  const createNode = useCallback(
    (parentPath: string | null, title: string, nodeType: "page" | "folder") => {
      if (!syncReady) {
        surfaceError("The wiki is still syncing — try again in a moment.");
        return null;
      }
      const slug = availableWikiSlug(title, pages, parentPath);
      if (!slug) {
        surfaceError(`Cannot derive a page name from "${title}".`);
        return null;
      }
      const id = crypto.randomUUID();
      const path = parentPath ? `${parentPath}/${slug}` : slug;
      const now = new Date().toISOString();
      trackPersistence(
        collections.pages.insert({
          id,
          slug,
          path,
          title,
          nodeType,
          kind: "other",
          body: "",
          contentHash: "0".repeat(64),
          sizeBytes: 0,
          format: "markdown",
          mimeType: null,
          originalFileName: null,
          assetSizeBytes: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      return { id, slug, path, title, nodeType };
    },
    [collections, pages, surfaceError, syncReady, trackPersistence],
  );

  // New pages start with an empty name ("Untitled" placeholder) and open with
  // the title focused, ready to type — the Notion flow.
  const openCreatedPage = useCallback(
    (created: { id: string; path: string }) => {
      focusTitlePageIdRef.current = created.id;
      navigate(created.path);
    },
    [navigate],
  );

  const createAndOpenPage = useCallback(
    (parentPath: string | null) => {
      const created = createNode(parentPath, "", "page");
      if (created) openCreatedPage(created);
      return created;
    },
    [createNode, openCreatedPage],
  );

  const createFolder = useCallback(
    (parentPath: string | null) => createNode(parentPath, "", "folder"),
    [createNode],
  );

  const renameNode = useCallback(
    (target: WikiPageData, title: string) => {
      if (!syncReady) return;
      const parentPath = parentWikiPath(target.path);
      const slug = availableWikiSlug(title, pages, parentPath, target.id);
      if (!slug) {
        surfaceError(`Cannot derive a page name from "${title}".`);
        return;
      }
      if (target.title === title && target.slug === slug) return;
      const path = parentPath ? `${parentPath}/${slug}` : slug;
      // The server owns subtree and backlink rewrites. Updating descendants in
      // this client transaction would persist their pre-rewrite bodies again.
      const transaction = collections.pages.update(target.id, (draft) => {
        draft.path = path;
        draft.slug = slug;
        draft.title = title;
      });
      trackPersistence(transaction);
      if (selectedPath === target.path || selectedPath?.startsWith(`${target.path}/`)) {
        const destination = movedWikiPath(selectedPath, target.path, path);
        if (target.nodeType === "folder") {
          transaction.isPersisted.promise.then(
            () => navigate(destination),
            () => undefined,
          );
        } else {
          navigate(destination);
          transaction.isPersisted.promise.catch(() => navigate(selectedPath));
        }
      }
    },
    [collections, navigate, pages, selectedPath, surfaceError, syncReady, trackPersistence],
  );

  const deleteNode = useCallback(
    (target: WikiPageData) => {
      if (!syncReady) {
        surfaceError("The wiki is still syncing — try again in a moment.");
        return;
      }
      const doomed =
        target.nodeType === "folder"
          ? pages.filter(
              (entry) => entry.path === target.path || entry.path.startsWith(`${target.path}/`),
            )
          : [target];
      const message =
        target.nodeType === "folder"
          ? `Delete folder "${target.title || target.slug}" and all its contents?`
          : `Delete "${target.title || target.slug}"?`;
      if (!window.confirm(message)) return;
      trackPersistence(collections.pages.delete(doomed.map((entry) => entry.id)));
      if (selectedPath === target.path || selectedPath?.startsWith(`${target.path}/`)) {
        navigate(null);
      }
    },
    [collections, navigate, pages, selectedPath, surfaceError, syncReady, trackPersistence],
  );

  return (
    <div className="flex h-full min-h-0 w-full">
      <WikiTreeSidebar
        key={`${userWorkosId}:${workspaceId}`}
        nodes={nodes}
        expansionStorageScope={{ userWorkosId, workspaceId }}
        selectedPath={selectedPath}
        onSelect={navigate}
        onCreate={(parentPath, nodeType) =>
          nodeType === "folder" ? createFolder(parentPath) : createAndOpenPage(parentPath)
        }
        onRename={renameNode}
        onDelete={(node) => deleteNode(node)}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {error ? (
          <div className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </div>
        ) : null}
        {page ? (
          <WikiPageEditor
            key={page.id}
            page={page}
            pages={pages}
            collections={collections}
            editable={syncReady}
            wikiLinks={wikiLinks}
            pageTitles={pageTitles}
            backlinks={backlinksByPath.get(page.path) ?? []}
            timelineCount={timelineCountByPageId.get(page.id) ?? 0}
            focusTitlePageIdRef={focusTitlePageIdRef}
            onError={surfaceError}
            onNavigate={navigate}
            onDelete={() => deleteNode(page)}
            onCreateSibling={() => createNode(parentWikiPath(page.path), "", "page")}
            onOpenCreatedPage={openCreatedPage}
          />
        ) : (
          <WikiEmptyState
            hasPages={pages.some((entry) => entry.nodeType === "page")}
            onCreate={() => createAndOpenPage(null)}
          />
        )}
      </div>
    </div>
  );
}

// --- sidebar ----------------------------------------------------------------

type WikiContextMenuState = {
  x: number;
  y: number;
  /** The right-clicked node, or null for the sidebar background. */
  node: TreeNode | null;
};

export function WikiTreeSidebar({
  nodes,
  expansionStorageScope,
  selectedPath,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  nodes: TreeNode[];
  expansionStorageScope?: { userWorkosId: string; workspaceId: string };
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onCreate: (parentPath: string | null, nodeType: "page" | "folder") => { id: string } | null;
  onRename: (node: TreeNode, title: string) => void;
  onDelete: (node: TreeNode) => void;
}) {
  const expansionUserWorkosId = expansionStorageScope?.userWorkosId;
  const expansionWorkspaceId = expansionStorageScope?.workspaceId;
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => {
    if (!expansionUserWorkosId || !expansionWorkspaceId) return new Set();
    return loadWikiTreeExpandedFolderIds(
      window.localStorage,
      expansionUserWorkosId,
      expansionWorkspaceId,
    );
  });
  const [contextMenu, setContextMenu] = useState<WikiContextMenuState | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const toggle = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  useEffect(() => {
    if (!expansionUserWorkosId || !expansionWorkspaceId) return;
    persistWikiTreeExpandedFolderIds(
      window.localStorage,
      expansionUserWorkosId,
      expansionWorkspaceId,
      expandedFolderIds,
    );
  }, [expandedFolderIds, expansionUserWorkosId, expansionWorkspaceId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onPointerDown = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const openContextMenu = (event: React.MouseEvent, node: TreeNode | null) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-edge bg-surface-raised/40">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Wiki
        </span>
        <div className="flex items-center gap-0.5">
          <Link
            href="/wiki/sources"
            title="Wiki sources"
            aria-label="Wiki sources"
            className="rounded p-1 text-ink-subtle hover:bg-surface-sunken hover:text-ink"
          >
            <DatabaseZap className="h-3.5 w-3.5" />
          </Link>
          <button
            type="button"
            title="New page"
            onClick={() => onCreate(null, "page")}
            className="rounded p-1 text-ink-subtle hover:bg-surface-sunken hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click target only; creation is reachable via the header button */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        onContextMenu={(event) => openContextMenu(event, null)}
      >
        {nodes.map((node) => (
          <WikiTreeRow
            key={`${node.id}:${editingNodeId === node.id ? "editing" : "view"}`}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            expandedFolderIds={expandedFolderIds}
            onToggle={toggle}
            onSelect={onSelect}
            onContextMenu={openContextMenu}
            editingNodeId={editingNodeId}
            onFinishEditing={(node, title) => {
              setEditingNodeId(null);
              onRename(node, title);
            }}
            onCancelEditing={() => setEditingNodeId(null)}
          />
        ))}
        {nodes.length === 0 ? (
          <p className="px-2 pt-2 text-[12.5px] leading-5 text-ink-subtle">No pages yet.</p>
        ) : null}
      </div>
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          role="menu"
          aria-label="Wiki actions"
          className="fixed z-[90] min-w-[180px] overflow-hidden rounded-md border border-border-strong bg-surface-raised py-1 text-[12.5px] text-ink shadow-[0_10px_30px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenu.node?.nodeType === "folder" ? (
            <>
              <WikiMenuItem
                autoFocus
                icon={<Plus size={14} strokeWidth={1.8} />}
                label="New page"
                onClick={() => {
                  const parentPath = contextMenu.node?.path ?? null;
                  setContextMenu(null);
                  onCreate(parentPath, "page");
                }}
              />
              <WikiMenuItem
                icon={<Plus size={14} strokeWidth={1.8} />}
                label="New folder"
                onClick={() => {
                  const parentPath = contextMenu.node?.path ?? null;
                  setContextMenu(null);
                  const created = onCreate(parentPath, "folder");
                  if (created) setEditingNodeId(created.id);
                }}
              />
              <MenuDivider />
              <WikiMenuItem
                icon={<span className="inline-block w-3.5 text-center">T</span>}
                label="Rename"
                onClick={() => {
                  const node = contextMenu.node;
                  setContextMenu(null);
                  if (node) setEditingNodeId(node.id);
                }}
              />
              <MenuDivider />
              <WikiMenuItem
                icon={<Trash2 size={14} strokeWidth={1.8} />}
                label="Delete folder…"
                danger
                onClick={() => {
                  const node = contextMenu.node;
                  setContextMenu(null);
                  if (node) onDelete(node as TreeNode);
                }}
              />
            </>
          ) : contextMenu.node ? (
            <WikiMenuItem
              autoFocus
              icon={<Trash2 size={14} strokeWidth={1.8} />}
              label="Delete"
              danger
              onClick={() => {
                const node = contextMenu.node;
                setContextMenu(null);
                if (node) onDelete(node);
              }}
            />
          ) : (
            <>
              <WikiMenuItem
                autoFocus
                icon={<Plus size={14} strokeWidth={1.8} />}
                label="New page"
                onClick={() => {
                  setContextMenu(null);
                  onCreate(null, "page");
                }}
              />
              <WikiMenuItem
                icon={<Plus size={14} strokeWidth={1.8} />}
                label="New folder"
                onClick={() => {
                  setContextMenu(null);
                  const created = onCreate(null, "folder");
                  if (created) setEditingNodeId(created.id);
                }}
              />
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}

function WikiTreeRow({
  node,
  depth,
  selectedPath,
  expandedFolderIds,
  onToggle,
  onSelect,
  onContextMenu,
  editingNodeId,
  onFinishEditing,
  onCancelEditing,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expandedFolderIds: Set<string>;
  onToggle: (folderId: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  editingNodeId: string | null;
  onFinishEditing: (node: TreeNode, title: string) => void;
  onCancelEditing: () => void;
}) {
  const isExpanded = node.nodeType === "folder" && expandedFolderIds.has(node.id);
  const isSelected = node.nodeType === "page" && selectedPath === node.path;
  const isEditing = editingNodeId === node.id;
  const [titleDraft, setTitleDraft] = useState(node.title);

  return (
    <div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click affordance on the row container */}
      <div
        className={`group relative flex items-center gap-1 rounded-md py-1 pr-1 text-[13px] leading-5 ${
          isSelected
            ? "bg-surface-sunken font-medium text-ink"
            : "text-ink-muted hover:bg-surface-sunken/60 hover:text-ink"
        }`}
        style={{ paddingLeft: `${depth * 24 + 4}px` }}
        onContextMenu={(event) => onContextMenu(event, node)}
        onClick={() => {
          if (node.nodeType === "folder" && !isEditing) onToggle(node.id);
        }}
      >
        {Array.from({ length: depth }, (_, index) => (
          <span
            key={`${node.id}:guide:${index}`}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 border-l border-edge"
            style={{ left: `${index * 24 + 13}px` }}
          />
        ))}
        {node.nodeType === "folder" ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle(node.id);
            }}
            className="rounded p-0.5 text-ink-subtle hover:text-ink"
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : null}
        {isEditing ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => onFinishEditing(node, titleDraft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onFinishEditing(node, titleDraft);
              if (event.key === "Escape") onCancelEditing();
            }}
            onClick={(event) => event.stopPropagation()}
            className="min-w-0 flex-1 rounded-sm border border-edge bg-surface px-1 text-[13px] leading-5 text-ink outline-none"
            aria-label="Folder title"
          />
        ) : node.nodeType === "folder" ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle(node.id);
            }}
            className="min-w-0 flex-1 truncate text-left"
            title={node.path}
          >
            {node.title || node.slug}
          </button>
        ) : (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(node.path);
            }}
            className="min-w-0 flex-1 truncate text-left"
            title={node.path}
          >
            {node.title || "Untitled"}
          </button>
        )}
      </div>
      {isExpanded
        ? node.children.map((child) => (
            <WikiTreeRow
              key={`${child.id}:${editingNodeId === child.id ? "editing" : "view"}`}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedFolderIds={expandedFolderIds}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              editingNodeId={editingNodeId}
              onFinishEditing={onFinishEditing}
              onCancelEditing={onCancelEditing}
            />
          ))
        : null}
    </div>
  );
}

// --- page editor ------------------------------------------------------------

function WikiPageEditor({
  page,
  pages,
  collections,
  editable,
  wikiLinks,
  pageTitles,
  backlinks,
  timelineCount,
  focusTitlePageIdRef,
  onError,
  onNavigate,
  onDelete,
  onCreateSibling,
  onOpenCreatedPage,
}: {
  page: WikiPageData;
  pages: WikiPageData[];
  collections: HeadlessWikiCollections;
  editable: boolean;
  wikiLinks: Record<string, string>;
  pageTitles: Record<string, string>;
  backlinks: Array<{ path: string; title: string }>;
  timelineCount: number;
  focusTitlePageIdRef: RefObject<string | null>;
  onError: (message: string | undefined) => void;
  onNavigate: (path: string | null) => void;
  onDelete: () => void;
  onCreateSibling: () => { id: string; slug: string; path: string; title: string } | null;
  onOpenCreatedPage: (created: { id: string; path: string }) => void;
}) {
  const [saveState, setSaveState] = useState<"saved" | "dirty">("saved");
  const [showTimeline, setShowTimeline] = useState(false);
  const [titleFocused, setTitleFocused] = useState(false);
  const pendingSaves = useRef(0);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // The focused input owns its text (no cursor fights with the store); the
  // optimistic collection update on each keystroke keeps the sidebar and every
  // [[link]] chip in sync on the same keystroke. When the input is not
  // focused, external edits (agents, other tabs) flow back in.
  const [titleDraft, setTitleDraft] = useState(page.title);
  const [prevSyncedTitle, setPrevSyncedTitle] = useState(page.title);
  if (page.title !== prevSyncedTitle) {
    setPrevSyncedTitle(page.title);
    if (!titleFocused) setTitleDraft(page.title);
  }

  const savePage = usePacedMutations<{ title?: string; content?: string }>({
    onMutate: (patch) => {
      collections.pages.update(page.id, (draft) => {
        if (patch.title !== undefined) draft.title = patch.title;
        if (patch.content !== undefined) draft.body = patch.content;
      });
    },
    mutationFn: async ({ transaction }) => {
      // A row can vanish between the keystroke and the debounced flush (page
      // deleted); saving it would silently re-create the page.
      const mutations = asHeadlessWikiPageWriteMutations(transaction.mutations).filter(
        (mutation) => collections.pages.get(mutation.original.id) !== undefined,
      );
      const txids = await persistHeadlessWikiPageWrites(mutations);
      // The write is durable once the action returns; waiting for the txids to
      // stream back only holds optimistic state so nothing flickers. A missed
      // txid (e.g. Electric briefly unreachable) must not fail the save.
      await Promise.all(
        txids.map((txid) => collections.pages.utils.awaitTxId(txid).catch(() => undefined)),
      );
    },
    strategy: debounceStrategy({ wait: SAVE_DEBOUNCE_MS }),
  });

  const queueSave = useCallback(
    (patch: { title?: string; content?: string }) => {
      setSaveState("dirty");
      pendingSaves.current += 1;
      savePage(patch).isPersisted.promise.then(
        () => {
          pendingSaves.current -= 1;
          if (pendingSaves.current === 0) setSaveState("saved");
        },
        (cause: unknown) => {
          pendingSaves.current -= 1;
          onError(cause instanceof Error ? cause.message : undefined);
        },
      );
    },
    [onError, savePage],
  );

  // A page created this session opens with its empty name focused, ready to
  // type — like Notion.
  useEffect(() => {
    if (focusTitlePageIdRef.current !== page.id) return;
    focusTitlePageIdRef.current = null;
    titleInputRef.current?.focus();
  }, [focusTitlePageIdRef, page.id]);

  const setKind = useCallback(
    (kind: WikiKind) => {
      if (!editable) return;
      collections.pages
        .update(page.id, (draft) => {
          draft.kind = kind;
        })
        .isPersisted.promise.catch((cause: unknown) =>
          onError(cause instanceof Error ? cause.message : undefined),
        );
    },
    [collections, editable, onError, page.id],
  );

  // The editor captures its slash-command handlers once at mount; route them
  // through refs so `/page` always sees the current tree.
  const createSiblingRef = useRef(onCreateSibling);
  const openCreatedPageRef = useRef(onOpenCreatedPage);
  useEffect(() => {
    createSiblingRef.current = onCreateSibling;
    openCreatedPageRef.current = onOpenCreatedPage;
  }, [onCreateSibling, onOpenCreatedPage]);
  const [slashHandlers] = useState(() => ({
    createPage: () => createSiblingRef.current(),
    onPageCreated: (created: { id: string; path: string }) => openCreatedPageRef.current(created),
  }));

  const commitTitlePath = useCallback(() => {
    if (!editable) return;
    const parentPath = parentWikiPath(page.path);
    const slug = availableWikiSlug(titleDraft, pages, parentPath, page.id);
    if (!slug || slug === page.slug) return;
    const path = parentPath ? `${parentPath}/${slug}` : slug;
    const transaction = collections.pages.update(page.id, (draft) => {
      draft.slug = slug;
      draft.path = path;
      draft.title = titleDraft;
    });
    onNavigate(path);
    transaction.isPersisted.promise.catch((cause: unknown) => {
      onNavigate(page.path);
      onError(cause instanceof Error ? cause.message : undefined);
    });
  }, [collections, editable, onError, onNavigate, page, pages, titleDraft]);

  const segments = page.path.split("/");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-5">
      {/* Breadcrumbs + status + page menu */}
      <div className="flex items-center justify-between gap-3">
        <nav className="flex min-w-0 items-center gap-1 text-[12.5px] text-ink-subtle">
          <BookOpen className="h-3.5 w-3.5 shrink-0" />
          {segments.map((segment, index) => {
            const ancestorPath = segments.slice(0, index + 1).join("/");
            const isLast = index === segments.length - 1;
            const ancestor = pages.find((entry) => entry.path === ancestorPath);
            const label = ancestor ? ancestor.title || "Untitled" : segment;
            return (
              <span key={ancestorPath} className="flex min-w-0 items-center gap-1">
                <span className="text-ink-subtle/60">/</span>
                <span className={isLast ? "truncate text-ink-muted" : "truncate"}>{label}</span>
              </span>
            );
          })}
        </nav>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[11.5px] text-ink-subtle">
            {saveState === "saved" ? "Saved" : "Saving…"}
          </span>
          <WikiPageMenu
            page={page}
            timelineCount={timelineCount}
            showTimeline={showTimeline}
            onSetKind={setKind}
            onToggleTimeline={() => setShowTimeline((current) => !current)}
            onDelete={onDelete}
          />
        </div>
      </div>

      {/* Name (Notion-style page title, separate from the markdown body) */}
      <input
        ref={titleInputRef}
        value={titleDraft}
        readOnly={!editable}
        onFocus={() => setTitleFocused(true)}
        onBlur={() => {
          setTitleFocused(false);
          commitTitlePath();
        }}
        onChange={(event) => {
          setTitleDraft(event.target.value);
          queueSave({ title: event.target.value });
        }}
        placeholder="Untitled"
        className="mt-3 w-full bg-transparent text-[26px] font-semibold leading-8 text-ink outline-none placeholder:text-ink-subtle/50"
      />

      {/* Body */}
      <div className="mt-4 flex-1">
        <MarkdownBrainEditor
          content={page.body}
          readOnly={!editable}
          onChange={(content) => queueSave({ content })}
          brainLinks={wikiLinks}
          pageTitles={pageTitles}
          onNavigateInternal={(href) => {
            onNavigate(href.replace(/^\/wiki\//, ""));
            return true;
          }}
          placeholder="Write, or type / for commands…"
          wikiSlashCommands={slashHandlers}
          blockHandles
        />
      </div>

      {showTimeline ? (
        <WikiTimelinePanel
          page={page}
          collections={collections}
          editable={editable}
          onError={onError}
        />
      ) : null}

      {backlinks.length > 0 ? (
        <div className="mt-6 border-t border-edge pt-3">
          <span className="text-[11.5px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Linked from
          </span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {backlinks.map((backlink) => (
              <button
                key={backlink.path}
                type="button"
                onClick={() => onNavigate(backlink.path)}
                className="rounded-full border border-edge px-2 py-0.5 text-[12px] text-ink-muted hover:bg-surface-sunken hover:text-ink"
              >
                {backlink.title || backlink.path}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- page menu (⋯) ----------------------------------------------------------

function WikiPageMenu({
  page,
  timelineCount,
  showTimeline,
  onSetKind,
  onToggleTimeline,
  onDelete,
}: {
  page: WikiPageData;
  timelineCount: number;
  showTimeline: boolean;
  onSetKind: (kind: WikiKind) => void;
  onToggleTimeline: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        title="Page options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`rounded-md p-1 hover:bg-surface-sunken hover:text-ink ${open ? "bg-surface-sunken text-ink" : "text-ink-subtle"}`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Page options"
          className="absolute right-0 top-full z-[90] mt-1 min-w-[190px] overflow-hidden rounded-md border border-border-strong bg-surface-raised py-1 text-[12.5px] text-ink shadow-[0_10px_30px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
        >
          <p className="px-2.5 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Kind
          </p>
          {WIKI_KINDS.map((kind) => (
            <WikiMenuItem
              key={kind}
              icon={
                page.kind === kind ? (
                  <Check size={14} strokeWidth={1.8} />
                ) : (
                  <span className="inline-block w-3.5" />
                )
              }
              label={kind}
              onClick={() => {
                setOpen(false);
                if (kind !== page.kind) onSetKind(kind);
              }}
            />
          ))}
          <MenuDivider />
          <WikiMenuItem
            icon={<History size={14} strokeWidth={1.8} />}
            label={`${showTimeline ? "Hide timeline" : "Timeline"}${timelineCount > 0 ? ` (${timelineCount})` : ""}`}
            onClick={() => {
              setOpen(false);
              onToggleTimeline();
            }}
          />
          <MenuDivider />
          <WikiMenuItem
            icon={<Trash2 size={14} strokeWidth={1.8} />}
            label="Delete page"
            danger
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

// --- shared menu bits -------------------------------------------------------

function WikiMenuItem({
  icon,
  label,
  onClick,
  danger = false,
  autoFocus = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      autoFocus={autoFocus}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left focus:outline-none ${
        danger
          ? "text-red-600 hover:bg-red-50 focus-visible:bg-red-50"
          : "text-ink-muted hover:bg-surface-sunken hover:text-ink focus-visible:bg-surface-sunken"
      }`}
    >
      <span className="shrink-0 text-ink-subtle">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function MenuDivider() {
  return <div className="my-1 h-px bg-edge" />;
}

// --- timeline ---------------------------------------------------------------

function WikiTimelinePanel({
  page,
  collections,
  editable,
  onError,
}: {
  page: WikiPageData;
  collections: HeadlessWikiCollections;
  editable: boolean;
  onError: (message: string | undefined) => void;
}) {
  const [text, setText] = useState("");
  const { data: entryRows } = useLiveQuery(
    (q) => q.from({ entry: collections.timeline }),
    [collections],
  );
  const entries = useMemo(
    () =>
      (entryRows ?? [])
        .filter((entry) => entry.pageId === page.id)
        .toSorted((a, b) => b.at.localeCompare(a.at)),
    [entryRows, page.id],
  );

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || !editable) return;
    setText("");
    const now = new Date().toISOString();
    collections.timeline
      .insert({
        id: crypto.randomUUID(),
        pageId: page.id,
        at: now,
        text: trimmed,
        createdAt: now,
      })
      .isPersisted.promise.catch((cause: unknown) =>
        onError(cause instanceof Error ? cause.message : undefined),
      );
  };

  return (
    <div className="mt-6 border-t border-edge pt-3">
      <span className="text-[11.5px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        Timeline
      </span>
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder="Add an entry — what happened?"
          className="flex-1 rounded-md border border-edge bg-surface px-2 py-1 text-[13px] text-ink outline-none placeholder:text-ink-subtle"
        />
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {entries.map((entry) => (
          <li key={entry.id} className="flex gap-2 text-[13px] leading-5">
            <span className="shrink-0 tabular-nums text-ink-subtle">{entry.at.slice(0, 10)}</span>
            <span className="min-w-0 text-ink-muted">{entry.text}</span>
          </li>
        ))}
        {entries.length === 0 ? (
          <li className="text-[12.5px] text-ink-subtle">No entries yet.</li>
        ) : null}
      </ul>
    </div>
  );
}

// --- empty state ------------------------------------------------------------

function WikiEmptyState({ hasPages, onCreate }: { hasPages: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <BookOpen className="h-8 w-8 text-ink-subtle" />
      <div>
        <p className="text-[15px] font-medium text-ink">
          {hasPages ? "Pick a page from the sidebar" : "Your workspace wiki"}
        </p>
        <p className="mt-1 max-w-sm text-[13px] leading-5 text-ink-subtle">
          {hasPages
            ? "Or create a new page or folder. Pages can link to other pages and to work in your other tools."
            : "Folders and markdown pages for you and your agents, organized like a filesystem."}
        </p>
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink-muted hover:bg-surface-sunken hover:text-ink"
      >
        <Plus className="h-3.5 w-3.5" /> New page
      </button>
    </div>
  );
}

// --- helpers ----------------------------------------------------------------

function pageRowToData(row: HeadlessWikiPageReadModel): WikiPageData {
  return {
    id: row.id,
    slug: row.slug,
    path: row.path,
    title: row.title,
    nodeType: row.nodeType,
    kind: row.kind,
    body: row.body,
  };
}

/** Sibling-unique slug for a new node title; null when suffixes are exhausted. */
export function availableWikiSlug(
  title: string,
  pages: WikiPageData[],
  parentPath: string | null,
  excludedNodeId?: string,
): string | null {
  const base = wikiSlugFromTitle(title.trim() || "Untitled") ?? "untitled";
  const taken = new Set(
    pages
      .filter((page) => page.id !== excludedNodeId && parentWikiPath(page.path) === parentPath)
      .map((page) => page.slug),
  );
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${base.slice(0, 76)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

export function buildTree(items: WikiPageData[]): TreeNode[] {
  const nodesByPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const sorted = [...items].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
  );
  for (const item of sorted) {
    const node: TreeNode = { ...item, children: [] };
    nodesByPath.set(item.path, node);
    const separator = item.path.lastIndexOf("/");
    const parent = separator === -1 ? null : nodesByPath.get(item.path.slice(0, separator));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortLevel = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.nodeType !== b.nodeType) return a.nodeType === "folder" ? -1 : 1;
      const aLabel = a.title || (a.nodeType === "folder" ? a.slug : "Untitled");
      const bLabel = b.title || (b.nodeType === "folder" ? b.slug : "Untitled");
      return aLabel.localeCompare(bLabel, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) sortLevel(node.children);
  };
  sortLevel(roots);
  return roots;
}
