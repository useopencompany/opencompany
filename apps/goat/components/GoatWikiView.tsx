"use client";

// The wiki surface: a Notion-lite tree of markdown pages with subpages.
// Server components load the data; every mutation goes through the same
// storage layer as the `wiki` agent tool. No live sync in the preview — the
// route re-renders on navigation and after actions.

import { WIKI_KINDS } from "@opencompany/goat-wiki";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  History,
  Plus,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownGoatBrainEditor } from "@/components/MarkdownGoatBrainEditor";
import {
  addWikiTimelineEntryAction,
  createWikiPageAction,
  deleteWikiPageAction,
  moveWikiPageAction,
  saveWikiPageAction,
  setWikiPageKindAction,
} from "@/lib/wiki-actions";

export type WikiTreeItem = {
  slug: string;
  path: string;
  title: string;
  kind: string;
  updatedAt: string;
};

export type WikiPageProps = {
  slug: string;
  path: string;
  title: string;
  kind: string;
  body: string;
  updatedAt: string;
  timeline: Array<{ id: string; at: string; text: string }>;
  backlinks: Array<{ path: string; title: string }>;
};

type TreeNode = WikiTreeItem & { children: TreeNode[] };

const SAVE_DEBOUNCE_MS = 800;

export function GoatWikiView({ tree, page }: { tree: WikiTreeItem[]; page: WikiPageProps | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const nodes = useMemo(() => buildTree(tree), [tree]);
  const wikiLinks = useMemo(
    () => Object.fromEntries(tree.map((item) => [item.slug, `/wiki/${item.path}`])),
    [tree],
  );

  const surfaceError = useCallback((message: string | undefined) => {
    setError(message ?? "Something went wrong.");
    window.setTimeout(() => setError(null), 6_000);
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full">
      <WikiTreeSidebar nodes={nodes} selectedPath={page?.path ?? null} onError={surfaceError} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {error ? (
          <div className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </div>
        ) : null}
        {page ? (
          <WikiPageEditor
            key={page.path}
            page={page}
            tree={tree}
            wikiLinks={wikiLinks}
            onError={surfaceError}
          />
        ) : (
          <WikiEmptyState hasPages={tree.length > 0} onError={surfaceError} />
        )}
      </div>
    </div>
  );
}

// --- sidebar ----------------------------------------------------------------

function WikiTreeSidebar({
  nodes,
  selectedPath,
  onError,
}: {
  nodes: TreeNode[];
  selectedPath: string | null;
  onError: (message: string | undefined) => void;
}) {
  const router = useRouter();
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
            parentPath={null}
            onDone={(path) => {
              setCreating(false);
              if (path) router.push(`/wiki/${path}`);
            }}
            onError={onError}
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
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
}) {
  const router = useRouter();
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
          onClick={() => router.push(`/wiki/${node.path}`)}
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
            />
          ))
        : null}
    </div>
  );
}

function NewPageInput({
  parentPath,
  onDone,
  onError,
}: {
  parentPath: string | null;
  onDone: (createdPath: string | null) => void;
  onError: (message: string | undefined) => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return onDone(null);
    setBusy(true);
    const result = await createWikiPageAction({ parentPath, title: trimmed });
    setBusy(false);
    if (result.ok) onDone(result.path);
    else {
      onError(result.error);
      onDone(null);
    }
  };

  return (
    <input
      autoFocus
      value={title}
      disabled={busy}
      onChange={(event) => setTitle(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") void submit();
        if (event.key === "Escape") onDone(null);
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
  tree,
  wikiLinks,
  onError,
}: {
  page: WikiPageProps;
  tree: WikiTreeItem[];
  wikiLinks: Record<string, string>;
  onError: (message: string | undefined) => void;
}) {
  const router = useRouter();
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [showTimeline, setShowTimeline] = useState(page.timeline.length > 0);
  const [creatingSubpage, setCreatingSubpage] = useState(false);
  const latestBody = useRef(page.body);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setSaveState("saving");
    const result = await saveWikiPageAction({ path: page.path, body: latestBody.current });
    if (result.ok) setSaveState("saved");
    else {
      setSaveState("dirty");
      onError(result.error);
    }
  }, [page.path, onError]);

  const onChange = useCallback(
    (content: string) => {
      latestBody.current = content;
      setSaveState("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Flush pending edits when the tab hides or the component unmounts.
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
    () => tree.filter((item) => item.path !== page.path && !item.path.startsWith(`${page.path}/`)),
    [tree, page.path],
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
            return (
              <span key={ancestorPath} className="flex min-w-0 items-center gap-1">
                <span className="text-ink-subtle/60">/</span>
                {isLast ? (
                  <span className="truncate text-ink-muted">{segment}</span>
                ) : (
                  <button
                    type="button"
                    className="truncate hover:text-ink"
                    onClick={() => router.push(`/wiki/${ancestorPath}`)}
                  >
                    {segment}
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

      {/* Page controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
        <select
          value={page.kind}
          onChange={(event) => {
            void setWikiPageKindAction({ slug: page.slug, kind: event.target.value }).then(
              (result) => {
                if (!result.ok) onError(result.error);
                router.refresh();
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
          onClick={() => setCreatingSubpage(true)}
          className="flex items-center gap-1 rounded-md border border-edge px-2 py-0.5 text-ink-muted hover:bg-surface-sunken hover:text-ink"
        >
          <CornerDownRight className="h-3 w-3" /> Subpage
        </button>
        <select
          value=""
          onChange={(event) => {
            const to = event.target.value;
            if (!to) return;
            void moveWikiPageAction({
              slug: page.slug,
              newParentPath: to === "/" ? null : to,
            }).then((result) => {
              if (result.ok) router.push(`/wiki/${result.path}`);
              else onError(result.error);
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
          {page.timeline.length > 0 ? ` (${page.timeline.length})` : ""}
        </button>
        <button
          type="button"
          onClick={() => {
            const hasChildren = tree.some((item) => item.path.startsWith(`${page.path}/`));
            const message = hasChildren
              ? `Delete "${page.title || page.slug}" and all its subpages?`
              : `Delete "${page.title || page.slug}"?`;
            if (!window.confirm(message)) return;
            void deleteWikiPageAction({ slug: page.slug, recursive: true }).then((result) => {
              if (result.ok) router.push("/wiki");
              else onError(result.error);
            });
          }}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-0.5 text-ink-subtle hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-3 w-3" /> Delete
        </button>
      </div>

      {creatingSubpage ? (
        <div className="mt-2 max-w-xs">
          <NewPageInput
            parentPath={page.path}
            onDone={(path) => {
              setCreatingSubpage(false);
              if (path) router.push(`/wiki/${path}`);
            }}
            onError={onError}
          />
        </div>
      ) : null}

      {/* Body */}
      <div className="mt-4 flex-1">
        <MarkdownGoatBrainEditor
          content={page.body}
          onChange={onChange}
          brainLinks={wikiLinks}
          onNavigateInternal={(href) => {
            router.push(href);
            return true;
          }}
          placeholder="Write the page…"
        />
      </div>

      {showTimeline ? <WikiTimelinePanel page={page} onError={onError} /> : null}

      {page.backlinks.length > 0 ? (
        <div className="mt-6 border-t border-edge pt-3">
          <span className="text-[11.5px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Linked from
          </span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {page.backlinks.map((backlink) => (
              <button
                key={backlink.path}
                type="button"
                onClick={() => router.push(`/wiki/${backlink.path}`)}
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
}: {
  page: WikiPageProps;
  onError: (message: string | undefined) => void;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const result = await addWikiTimelineEntryAction({ slug: page.slug, text: trimmed });
    setBusy(false);
    if (result.ok) {
      setText("");
      router.refresh();
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
        {page.timeline.map((entry) => (
          <li key={entry.id} className="flex gap-2 text-[13px] leading-5">
            <span className="shrink-0 tabular-nums text-ink-subtle">{entry.at.slice(0, 10)}</span>
            <span className="min-w-0 text-ink-muted">{entry.text}</span>
          </li>
        ))}
        {page.timeline.length === 0 ? (
          <li className="text-[12.5px] text-ink-subtle">No entries yet.</li>
        ) : null}
      </ul>
    </div>
  );
}

// --- empty state ------------------------------------------------------------

function WikiEmptyState({
  hasPages,
  onError,
}: {
  hasPages: boolean;
  onError: (message: string | undefined) => void;
}) {
  const router = useRouter();
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
            parentPath={null}
            onDone={(path) => {
              setCreating(false);
              if (path) router.push(`/wiki/${path}`);
            }}
            onError={onError}
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

function buildTree(items: WikiTreeItem[]): TreeNode[] {
  const nodesByPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  // Items arrive path-sorted, so parents precede children.
  for (const item of items) {
    const node: TreeNode = { ...item, children: [] };
    nodesByPath.set(item.path, node);
    const separator = item.path.lastIndexOf("/");
    const parent = separator === -1 ? null : nodesByPath.get(item.path.slice(0, separator));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
