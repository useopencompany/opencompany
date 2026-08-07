"use client";

// The wiki surface: a Notion-lite tree of markdown pages with subpages.
//
// The server ships every page (bodies included) once; selection, the tree, and
// backlinks are pure client state, so navigating between pages is instant —
// the URL updates via history.pushState and the App Router keeps usePathname
// in sync without a server round-trip. Mutations go through server actions
// (the same storage layer as the `wiki` agent tool) with optimistic local
// updates; router.refresh() reconciles in the background.

import { movedWikiPath, WIKI_KINDS, wikiPageLinkTargets } from "@opencompany/goat-wiki";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  History,
  Plus,
  Trash2,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownGoatBrainEditor } from "@/components/MarkdownGoatBrainEditor";
import {
  addWikiTimelineEntryAction,
  createWikiPageAction,
  deleteWikiPageAction,
  getWikiTimelineAction,
  moveWikiPageAction,
  saveWikiPageAction,
  setWikiPageKindAction,
} from "@/lib/wiki-actions";

export type WikiPageData = {
  slug: string;
  path: string;
  title: string;
  kind: string;
  body: string;
  updatedAt: string;
  timelineCount: number;
};

type TreeNode = WikiPageData & { children: TreeNode[] };

const SAVE_DEBOUNCE_MS = 800;

export function GoatWikiView({
  pages: serverPages,
  initialPath,
}: {
  pages: WikiPageData[];
  initialPath: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pages, setPages] = useState(serverPages);
  const [error, setError] = useState<string | null>(null);

  // Server data wins whenever a fresh RSC payload arrives (router.refresh()
  // after mutations, or a hard navigation).
  useEffect(() => {
    setPages(serverPages);
  }, [serverPages]);

  const selectedPath = useMemo(() => {
    const fromUrl = pathname.replace(/^\/wiki\/?/, "");
    return fromUrl ? decodeURIComponent(fromUrl) : (initialPath ?? null);
  }, [pathname, initialPath]);

  const navigate = useCallback((path: string | null) => {
    window.history.pushState(null, "", path ? `/wiki/${path}` : "/wiki");
  }, []);

  const nodes = useMemo(() => buildTree(pages), [pages]);
  const wikiLinks = useMemo(
    () => Object.fromEntries(pages.map((page) => [page.slug, `/wiki/${page.path}`])),
    [pages],
  );
  const backlinksBySlug = useMemo(() => {
    const index = new Map<string, Array<{ path: string; title: string }>>();
    for (const page of pages) {
      for (const target of wikiPageLinkTargets(page.body)) {
        const existing = index.get(target);
        const entry = { path: page.path, title: page.title };
        if (existing) existing.push(entry);
        else index.set(target, [entry]);
      }
    }
    return index;
  }, [pages]);

  const page = selectedPath ? (pages.find((entry) => entry.path === selectedPath) ?? null) : null;

  const surfaceError = useCallback((message: string | undefined) => {
    setError(message ?? "Something went wrong.");
    window.setTimeout(() => setError(null), 6_000);
  }, []);

  const createPage = useCallback(
    async (parentPath: string | null, title: string) => {
      const result = await createWikiPageAction({ parentPath, title });
      if (!result.ok) {
        surfaceError(result.error);
        return null;
      }
      setPages((current) => [
        ...current,
        {
          slug: result.slug,
          path: result.path,
          title: result.title,
          kind: "other",
          body: "",
          updatedAt: new Date().toISOString(),
          timelineCount: 0,
        },
      ]);
      router.refresh();
      return result;
    },
    [router, surfaceError],
  );

  return (
    <div className="flex h-full min-h-0 w-full">
      <WikiTreeSidebar
        nodes={nodes}
        selectedPath={selectedPath}
        onSelect={navigate}
        onCreate={async (title) => {
          const created = await createPage(null, title);
          if (created) navigate(created.path);
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {error ? (
          <div className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </div>
        ) : null}
        {page ? (
          <WikiPageEditor
            key={page.slug}
            page={page}
            pages={pages}
            wikiLinks={wikiLinks}
            backlinks={backlinksBySlug.get(page.slug) ?? []}
            onError={surfaceError}
            onNavigate={navigate}
            onLocalUpdate={(slug, patch) =>
              setPages((current) =>
                current.map((entry) => (entry.slug === slug ? { ...entry, ...patch } : entry)),
              )
            }
            onMove={(slug, fromPath, toPath) =>
              setPages((current) =>
                current.map((entry) => ({
                  ...entry,
                  path: movedWikiPath(entry.path, fromPath, toPath),
                })),
              )
            }
            onDelete={(deletedPaths) =>
              setPages((current) => current.filter((entry) => !deletedPaths.includes(entry.path)))
            }
            onCreateSubpage={(title) => createPage(page.path, title)}
          />
        ) : (
          <WikiEmptyState
            hasPages={pages.length > 0}
            onCreate={async (title) => {
              const created = await createPage(null, title);
              if (created) navigate(created.path);
            }}
          />
        )}
      </div>
    </div>
  );
}

// --- sidebar ----------------------------------------------------------------

function WikiTreeSidebar({
  nodes,
  selectedPath,
  onSelect,
  onCreate,
}: {
  nodes: TreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onCreate: (title: string) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const toggle = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-edge bg-surface-raised/40">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Wiki
        </span>
        <button
          type="button"
          title="New page"
          onClick={() => setCreating(true)}
          className="rounded p-1 text-ink-subtle hover:bg-surface-sunken hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {creating ? (
          <NewPageInput
            onDone={async (title) => {
              setCreating(false);
              if (title) await onCreate(title);
            }}
          />
        ) : null}
        {nodes.map((node) => (
          <WikiTreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            collapsed={collapsed}
            onToggle={toggle}
            onSelect={onSelect}
          />
        ))}
        {nodes.length === 0 && !creating ? (
          <p className="px-2 pt-2 text-[12.5px] leading-5 text-ink-subtle">No pages yet.</p>
        ) : null}
      </div>
    </aside>
  );
}

function WikiTreeRow({
  node,
  depth,
  selectedPath,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isCollapsed = collapsed.has(node.path);
  const isSelected = selectedPath === node.path;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-md py-1 pr-1 text-[13px] leading-5 ${
          isSelected
            ? "bg-surface-sunken font-medium text-ink"
            : "text-ink-muted hover:bg-surface-sunken/60 hover:text-ink"
        }`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            className="rounded p-0.5 text-ink-subtle hover:text-ink"
            aria-label={isCollapsed ? "Expand" : "Collapse"}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          className="min-w-0 flex-1 truncate text-left"
          title={node.path}
        >
          {node.title || node.slug}
        </button>
      </div>
      {!isCollapsed
        ? node.children.map((child) => (
            <WikiTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  );
}

function NewPageInput({ onDone }: { onDone: (title: string | null) => Promise<void> | void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const trimmed = title.trim();
    if (!trimmed) return void onDone(null);
    setBusy(true);
    await onDone(trimmed);
    setBusy(false);
  };

  return (
    <input
      autoFocus
      value={title}
      disabled={busy}
      onChange={(event) => setTitle(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") void submit();
        if (event.key === "Escape") void onDone(null);
      }}
      onBlur={() => void submit()}
      placeholder="Page title…"
      className="mb-1 w-full rounded-md border border-edge bg-surface px-2 py-1 text-[13px] text-ink outline-none placeholder:text-ink-subtle"
    />
  );
}

// --- page editor ------------------------------------------------------------

function WikiPageEditor({
  page,
  pages,
  wikiLinks,
  backlinks,
  onError,
  onNavigate,
  onLocalUpdate,
  onMove,
  onDelete,
  onCreateSubpage,
}: {
  page: WikiPageData;
  pages: WikiPageData[];
  wikiLinks: Record<string, string>;
  backlinks: Array<{ path: string; title: string }>;
  onError: (message: string | undefined) => void;
  onNavigate: (path: string | null) => void;
  onLocalUpdate: (slug: string, patch: Partial<WikiPageData>) => void;
  onMove: (slug: string, fromPath: string, toPath: string) => void;
  onDelete: (deletedPaths: string[]) => void;
  onCreateSubpage: (title: string) => Promise<{ slug: string; title: string; path: string } | null>;
}) {
  const router = useRouter();
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [showTimeline, setShowTimeline] = useState(false);
  const [name, setName] = useState(page.title);
  const latestBody = useRef(page.body);
  const latestName = useRef(page.title);
  const pathRef = useRef(page.path);
  pathRef.current = page.path;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setSaveState("saving");
    const result = await saveWikiPageAction({
      path: pathRef.current,
      body: latestBody.current,
      title: latestName.current,
    });
    if (result.ok) {
      setSaveState("saved");
      onLocalUpdate(page.slug, { body: latestBody.current, title: result.title });
    } else {
      setSaveState("dirty");
      onError(result.error);
    }
  }, [page.slug, onLocalUpdate, onError]);

  const queueSave = useCallback(() => {
    setSaveState("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Flush pending edits when the tab hides or the page unmounts.
  useEffect(() => {
    const onHide = () => {
      if (saveTimer.current) void flush();
    };
    window.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("visibilitychange", onHide);
      onHide();
    };
  }, [flush]);

  const parentOptions = useMemo(
    () => pages.filter((item) => item.path !== page.path && !item.path.startsWith(`${page.path}/`)),
    [pages, page.path],
  );
  const segments = page.path.split("/");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-5">
      {/* Breadcrumbs + status */}
      <div className="flex items-center justify-between gap-3">
        <nav className="flex min-w-0 items-center gap-1 text-[12.5px] text-ink-subtle">
          <BookOpen className="h-3.5 w-3.5 shrink-0" />
          {segments.map((segment, index) => {
            const ancestorPath = segments.slice(0, index + 1).join("/");
            const isLast = index === segments.length - 1;
            const ancestor = pages.find((entry) => entry.path === ancestorPath);
            const label = ancestor?.title || segment;
            return (
              <span key={ancestorPath} className="flex min-w-0 items-center gap-1">
                <span className="text-ink-subtle/60">/</span>
                {isLast ? (
                  <span className="truncate text-ink-muted">{label}</span>
                ) : (
                  <button
                    type="button"
                    className="truncate hover:text-ink"
                    onClick={() => onNavigate(ancestorPath)}
                  >
                    {label}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
        <span className="shrink-0 text-[11.5px] text-ink-subtle">
          {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Unsaved"}
        </span>
      </div>

      {/* Name (Notion-style page title, separate from the markdown body) */}
      <input
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          latestName.current = event.target.value;
          onLocalUpdate(page.slug, { title: event.target.value });
          queueSave();
        }}
        placeholder="Untitled"
        className="mt-3 w-full bg-transparent text-[26px] font-semibold leading-8 text-ink outline-none placeholder:text-ink-subtle/50"
      />

      {/* Page controls */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
        <select
          value={page.kind}
          onChange={(event) => {
            onLocalUpdate(page.slug, { kind: event.target.value });
            void setWikiPageKindAction({ slug: page.slug, kind: event.target.value }).then(
              (result) => {
                if (!result.ok) onError(result.error);
              },
            );
          }}
          className="rounded-md border border-edge bg-surface px-1.5 py-0.5 text-ink-muted"
          title="Page kind"
        >
          {WIKI_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={async () => {
            const created = await onCreateSubpage("Untitled");
            if (created) onNavigate(created.path);
          }}
          className="flex items-center gap-1 rounded-md border border-edge px-2 py-0.5 text-ink-muted hover:bg-surface-sunken hover:text-ink"
        >
          <CornerDownRight className="h-3 w-3" /> Subpage
        </button>
        <select
          value=""
          onChange={(event) => {
            const to = event.target.value;
            if (!to) return;
            const fromPath = page.path;
            void moveWikiPageAction({
              slug: page.slug,
              newParentPath: to === "/" ? null : to,
            }).then((result) => {
              if (result.ok) {
                onMove(page.slug, fromPath, result.path);
                onNavigate(result.path);
              } else onError(result.error);
            });
          }}
          className="rounded-md border border-edge bg-surface px-1.5 py-0.5 text-ink-muted"
          title="Move page"
        >
          <option value="">Move to…</option>
          {segments.length > 1 ? <option value="/">/ (root)</option> : null}
          {parentOptions.map((item) => (
            <option key={item.path} value={item.path}>
              /{item.path}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setShowTimeline((current) => !current)}
          className={`flex items-center gap-1 rounded-md border border-edge px-2 py-0.5 hover:bg-surface-sunken hover:text-ink ${showTimeline ? "text-ink" : "text-ink-muted"}`}
        >
          <History className="h-3 w-3" /> Timeline
          {page.timelineCount > 0 ? ` (${page.timelineCount})` : ""}
        </button>
        <button
          type="button"
          onClick={() => {
            const hasChildren = pages.some((item) => item.path.startsWith(`${page.path}/`));
            const message = hasChildren
              ? `Delete "${page.title || page.slug}" and all its subpages?`
              : `Delete "${page.title || page.slug}"?`;
            if (!window.confirm(message)) return;
            void deleteWikiPageAction({ slug: page.slug, recursive: true }).then((result) => {
              if (result.ok) {
                onDelete(result.deletedPaths);
                onNavigate(null);
                router.refresh();
              } else onError(result.error);
            });
          }}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-0.5 text-ink-subtle hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
      </div>

      {/* Body */}
      <div className="mt-4 flex-1">
        <MarkdownGoatBrainEditor
          content={page.body}
          onChange={(content) => {
            latestBody.current = content;
            queueSave();
          }}
          brainLinks={wikiLinks}
          onNavigateInternal={(href) => {
            onNavigate(href.replace(/^\/wiki\//, ""));
            return true;
          }}
          placeholder="Write, or type / for commands…"
          wikiSlashCommands={{
            createPage: async () => {
              const created = await onCreateSubpage("Untitled");
              return created ? { slug: created.slug, title: created.title } : null;
            },
          }}
        />
      </div>

      {showTimeline ? (
        <WikiTimelinePanel
          page={page}
          onError={onError}
          onAdded={() => onLocalUpdate(page.slug, { timelineCount: page.timelineCount + 1 })}
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

// --- timeline ---------------------------------------------------------------

function WikiTimelinePanel({
  page,
  onError,
  onAdded,
}: {
  page: WikiPageData;
  onError: (message: string | undefined) => void;
  onAdded: () => void;
}) {
  const [entries, setEntries] = useState<Array<{ id: string; at: string; text: string }> | null>(
    null,
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getWikiTimelineAction({ slug: page.slug }).then((result) => {
      if (cancelled) return;
      if (result.ok) setEntries(result.entries);
      else onError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [page.slug, onError]);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const result = await addWikiTimelineEntryAction({ slug: page.slug, text: trimmed });
    setBusy(false);
    if (result.ok) {
      setText("");
      setEntries((current) => [
        { id: `local-${result.at}`, at: result.at, text: trimmed },
        ...(current ?? []),
      ]);
      onAdded();
    } else onError(result.error);
  };

  return (
    <div className="mt-6 border-t border-edge pt-3">
      <span className="text-[11.5px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
        Timeline
      </span>
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          placeholder="Add an entry — what happened?"
          className="flex-1 rounded-md border border-edge bg-surface px-2 py-1 text-[13px] text-ink outline-none placeholder:text-ink-subtle"
        />
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {(entries ?? []).map((entry) => (
          <li key={entry.id} className="flex gap-2 text-[13px] leading-5">
            <span className="shrink-0 tabular-nums text-ink-subtle">{entry.at.slice(0, 10)}</span>
            <span className="min-w-0 text-ink-muted">{entry.text}</span>
          </li>
        ))}
        {entries !== null && entries.length === 0 ? (
          <li className="text-[12.5px] text-ink-subtle">No entries yet.</li>
        ) : null}
        {entries === null ? <li className="text-[12.5px] text-ink-subtle">Loading…</li> : null}
      </ul>
    </div>
  );
}

// --- empty state ------------------------------------------------------------

function WikiEmptyState({
  hasPages,
  onCreate,
}: {
  hasPages: boolean;
  onCreate: (title: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <BookOpen className="h-8 w-8 text-ink-subtle" />
      <div>
        <p className="text-[15px] font-medium text-ink">
          {hasPages ? "Pick a page from the sidebar" : "Your workspace wiki"}
        </p>
        <p className="mt-1 max-w-sm text-[13px] leading-5 text-ink-subtle">
          {hasPages
            ? "Or create a new page — every page can hold subpages, links to other pages, and links to work in your other tools."
            : "Markdown pages with subpages, for you and your agents. Agents browse it like a filesystem; you get a lightweight Notion."}
        </p>
      </div>
      {creating ? (
        <div className="w-56">
          <NewPageInput
            onDone={async (title) => {
              setCreating(false);
              if (title) await onCreate(title);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink-muted hover:bg-surface-sunken hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" /> New page
        </button>
      )}
    </div>
  );
}

// --- helpers ----------------------------------------------------------------

function buildTree(items: WikiPageData[]): TreeNode[] {
  const nodesByPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));
  for (const item of sorted) {
    const node: TreeNode = { ...item, children: [] };
    nodesByPath.set(item.path, node);
    const separator = item.path.lastIndexOf("/");
    const parent = separator === -1 ? null : nodesByPath.get(item.path.slice(0, separator));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
