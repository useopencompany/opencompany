"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { useLiveQuery } from "@tanstack/react-db";
import {
  ArrowLeft,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Inbox,
  Info,
  Lightbulb,
  Save,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { MarkdownGoatBrainEditor } from "@/components/MarkdownGoatBrainEditor";
import { useHydrated } from "@/components/useHydrated";
import type { GoatBrainDocumentView, GoatBrainFolderView } from "@/lib/brain";
import {
  createGoatBrainDocumentAction,
  createGoatBrainFolderAction,
  deleteGoatBrainDocumentAction,
  moveGoatBrainDocumentAction,
  updateGoatBrainDocumentAction,
} from "@/lib/brain-actions";
import {
  createGoatCollections,
  type GoatBrainDocumentRow,
  type GoatBrainFolderRow,
} from "@/lib/task-collections";

type Props = {
  folders: GoatBrainFolderView[];
  documents: GoatBrainDocumentView[];
  initialFolderPath: string | null;
  initialBrainId: string | null;
};

type BrainTreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  children: BrainTreeNode[];
  document?: GoatBrainDocumentView;
};

const ROOT_FOLDER_GROUPS = [
  ["inbox"],
  ["people", "meetings", "companies"],
  ["ideas", "decisions", "insights", "references", "research"],
  ["projects"],
];
const HIDDEN_EMPTY_ROOT_FOLDERS = new Set(["concepts", "docs"]);

export function GoatBrainView({ folders, documents, initialFolderPath, initialBrainId }: Props) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <GoatBrainEditor
        folders={folders}
        documents={documents}
        initialFolderPath={initialFolderPath}
        initialBrainId={initialBrainId}
      />
    );
  }
  return (
    <LiveGoatBrainView
      folders={folders}
      documents={documents}
      initialFolderPath={initialFolderPath}
      initialBrainId={initialBrainId}
    />
  );
}

function LiveGoatBrainView({
  folders: initialFolders,
  documents: initialDocuments,
  initialFolderPath,
  initialBrainId,
}: Props) {
  const collections = useMemo(() => createGoatCollections(), []);
  const { data: folderRows, isLoading: foldersLoading } = useLiveQuery((q) =>
    q.from({ folder: collections.brainFolders }),
  );
  const { data: documentRows, isLoading: documentsLoading } = useLiveQuery((q) =>
    q.from({ document: collections.brainDocuments }),
  );
  const folders = useMemo(() => {
    if (foldersLoading && !folderRows?.length) return initialFolders;
    return ((folderRows ?? []) as GoatBrainFolderRow[])
      .map(folderViewFromRow)
      .toSorted((a, b) => a.path.localeCompare(b.path));
  }, [folderRows, foldersLoading, initialFolders]);
  const documents = useMemo(() => {
    if (documentsLoading && !documentRows?.length) return initialDocuments;
    return ((documentRows ?? []) as GoatBrainDocumentRow[])
      .map(documentViewFromRow)
      .toSorted(compareBrainDocuments);
  }, [documentRows, documentsLoading, initialDocuments]);

  return (
    <GoatBrainEditor
      folders={folders}
      documents={documents}
      initialFolderPath={initialFolderPath}
      initialBrainId={initialBrainId}
    />
  );
}

function GoatBrainEditor({ folders, documents, initialFolderPath, initialBrainId }: Props) {
  const router = useRouter();
  const initialDocument = useMemo(
    () => resolveInitialDocument(documents, initialFolderPath, initialBrainId),
    [documents, initialBrainId, initialFolderPath],
  );
  const initialSelectedFolder = initialFolderPath ?? initialDocument?.folderPath ?? "inbox";
  const [selectedFolder, setSelectedFolder] = useState(initialSelectedFolder);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(
    initialDocument?.id ?? null,
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(ancestorFolderPaths(initialDocument?.folderPath ?? initialSelectedFolder)),
  );
  const [query, setQuery] = useState("");
  const [newFolderPath, setNewFolderPath] = useState("");
  const [newDocumentTitle, setNewDocumentTitle] = useState("");
  const [isPending, startTransition] = useTransition();

  const selectedDocument = useMemo(() => {
    if (!selectedDocumentId) return null;
    return documents.find((document) => document.id === selectedDocumentId) ?? null;
  }, [documents, selectedDocumentId]);
  const activeFolder = selectedDocument?.folderPath ?? selectedFolder;
  const activePath = selectedDocument ? brainDocumentTreePath(selectedDocument) : activeFolder;
  const tree = useMemo(
    () => buildBrainTree(folders, documents, query),
    [documents, folders, query],
  );
  const rootGroups = useMemo(() => groupRootNodes(tree.children), [tree.children]);
  const hasRootNodes = rootGroups.some((group) => group.length > 0);
  const isSearching = Boolean(query.trim());
  const visibleExpandedPaths = useMemo(
    () => (isSearching ? new Set(collectFolderPaths(tree)) : expandedPaths),
    [expandedPaths, isSearching, tree],
  );

  const selectDocument = (document: GoatBrainDocumentView) => {
    setSelectedFolder(document.folderPath);
    setSelectedDocumentId(document.id);
    setExpandedPaths((current) => withAncestorFolders(current, document.folderPath));
    router.replace(brainDocumentUrl(document));
  };

  const toggleFolder = (path: string) => {
    setSelectedFolder(path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const createFolder = () => {
    const path = newFolderPath.trim();
    if (!path) return;
    startTransition(async () => {
      const result = await createGoatBrainFolderAction(path);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const folderPath = result.path ?? path;
      setNewFolderPath("");
      setSelectedFolder(folderPath);
      setExpandedPaths((current) => withAncestorFolders(current, folderPath, true));
      router.replace(`/brain/${folderUrlSegments(folderPath)}`);
    });
  };

  const createDocument = () => {
    startTransition(async () => {
      const title = newDocumentTitle.trim();
      const result = await createGoatBrainDocumentAction({
        folderPath: activeFolder,
        ...(title ? { title } : {}),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const document = result.document;
      if (document) {
        setSelectedFolder(document.folderPath);
        setSelectedDocumentId(document.id);
        setExpandedPaths((current) => withAncestorFolders(current, document.folderPath, true));
      }
      setNewDocumentTitle("");
      if (result.path) router.replace(result.path);
    });
  };

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            aria-label="Back"
            title="Back"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <ArrowLeft size={16} strokeWidth={2} />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold leading-tight">Brain</h1>
            <p className="truncate text-[12px] leading-tight text-ink-subtle">
              {documents.length} docs / {folders.length} folders
            </p>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-[292px] shrink-0 flex-col border-r border-border bg-surface-muted">
          <div className="border-b border-border px-3 py-3">
            <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-ink-muted shadow-[0_1px_0_rgba(0,0,0,0.02)]">
              <Search size={13} strokeWidth={1.75} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search brain"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
              />
            </label>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
              <input
                value={newDocumentTitle}
                onChange={(event) => setNewDocumentTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") createDocument();
                }}
                placeholder={`new file in ${activeFolder}`}
                className="h-8 min-w-0 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-ink outline-none transition-colors duration-150 placeholder:text-ink-subtle focus:border-border-strong"
              />
              <button
                type="button"
                aria-label="Create brain file"
                title="Create brain file"
                onClick={createDocument}
                disabled={isPending}
                className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink disabled:opacity-45"
              >
                <FilePlus2 size={15} strokeWidth={1.8} />
              </button>
              <input
                value={newFolderPath}
                onChange={(event) => setNewFolderPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") createFolder();
                }}
                placeholder="new folder"
                className="h-8 min-w-0 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-ink outline-none transition-colors duration-150 placeholder:text-ink-subtle focus:border-border-strong"
              />
              <button
                type="button"
                aria-label="Create brain folder"
                title="Create brain folder"
                onClick={createFolder}
                disabled={isPending}
                className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink disabled:opacity-45"
              >
                <FolderPlus size={15} strokeWidth={1.8} />
              </button>
            </div>
          </div>

          <div role="tree" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            {hasRootNodes ? (
              <div className="space-y-px">
                {rootGroups.map((group, groupIndex) =>
                  group.length > 0 ? (
                    <div key={group.map((node) => node.path).join("|")}>
                      {groupIndex > firstNonEmptyGroupIndex(rootGroups) ? (
                        <div className="my-2 border-t border-border" />
                      ) : null}
                      {group.map((node) => (
                        <TreeItem
                          key={node.path}
                          node={node}
                          depth={0}
                          activePath={activePath}
                          expandedPaths={visibleExpandedPaths}
                          onSelect={selectDocument}
                          onToggleFolder={toggleFolder}
                        />
                      ))}
                    </div>
                  ) : null,
                )}
              </div>
            ) : (
              <div className="px-2 py-8 text-[12.5px] leading-5 text-ink-muted">
                {documents.length === 0 ? "No brain files yet." : "No files match that search."}
              </div>
            )}
          </div>
        </aside>

        <BrainDocumentPanel
          key={selectedDocument?.id ?? "empty"}
          selectedDocument={selectedDocument}
          documents={documents}
          folders={folders}
          selectedFolder={activeFolder}
          onSelectFolder={setSelectedFolder}
          onSelectDocumentId={setSelectedDocumentId}
          onExpandFolder={(folderPath) =>
            setExpandedPaths((current) => withAncestorFolders(current, folderPath, true))
          }
        />
      </div>
    </main>
  );
}

function TreeItem({
  node,
  depth,
  activePath,
  expandedPaths,
  onSelect,
  onToggleFolder,
}: {
  node: BrainTreeNode;
  depth: number;
  activePath: string;
  expandedPaths: Set<string>;
  onSelect: (document: GoatBrainDocumentView) => void;
  onToggleFolder: (path: string) => void;
}) {
  const active = node.path === activePath;
  const expanded = node.type === "folder" && expandedPaths.has(node.path);
  const showChildren = node.type === "folder" && expanded;
  const paddingStyle = { paddingLeft: `${6 + depth * 14}px` };

  return (
    <div>
      <button
        type="button"
        role="treeitem"
        aria-selected={active}
        aria-expanded={node.type === "folder" ? expanded : undefined}
        onClick={() => {
          if (node.type === "folder") onToggleFolder(node.path);
          else if (node.document) onSelect(node.document);
        }}
        className={`group flex w-full items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[12.5px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
          active
            ? "bg-surface-active text-ink"
            : "text-ink/85 hover:bg-surface-subtle hover:text-ink"
        }`}
        style={paddingStyle}
      >
        {node.type === "folder" ? (
          expanded ? (
            <ChevronDown size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
          )
        ) : (
          <span className="h-[13px] w-[13px] shrink-0" />
        )}
        {node.type === "folder" ? <FolderIcon path={node.path} /> : <FileIcon path={node.path} />}
        <span className="min-w-0 truncate tracking-[-0.005em]">{node.name}</span>
      </button>
      {showChildren
        ? node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggleFolder={onToggleFolder}
            />
          ))
        : null}
    </div>
  );
}

function BrainDocumentPanel({
  selectedDocument,
  documents,
  folders,
  selectedFolder,
  onSelectFolder,
  onSelectDocumentId,
  onExpandFolder,
}: {
  selectedDocument: GoatBrainDocumentView | null;
  documents: GoatBrainDocumentView[];
  folders: GoatBrainFolderView[];
  selectedFolder: string;
  onSelectFolder: (folderPath: string) => void;
  onSelectDocumentId: (documentId: string | null) => void;
  onExpandFolder: (folderPath: string) => void;
}) {
  const router = useRouter();
  const initialBody = useMemo(() => selectedDocument?.body ?? "", [selectedDocument]);
  const [editorValue, setEditorValue] = useState(initialBody);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const dirty = Boolean(selectedDocument && editorValue !== initialBody);

  const saveDocument = () => {
    if (!selectedDocument || !dirty) return;
    startTransition(async () => {
      const result = await updateGoatBrainDocumentAction({
        documentId: selectedDocument.id,
        body: editorValue,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const document = result.document;
      if (document) {
        onSelectFolder(document.folderPath);
        onSelectDocumentId(document.id);
        onExpandFolder(document.folderPath);
        setEditorValue(document.body);
      }
      toast.success("Saved");
      if (result.path) router.replace(result.path);
    });
  };

  const moveDocument = (folderPath: string) => {
    if (!selectedDocument || folderPath === selectedDocument.folderPath) return;
    startTransition(async () => {
      const result = await moveGoatBrainDocumentAction({
        documentId: selectedDocument.id,
        folderPath,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const document = result.document;
      if (document) {
        onSelectFolder(document.folderPath);
        onSelectDocumentId(document.id);
        onExpandFolder(document.folderPath);
        setEditorValue(document.body);
      }
      if (result.path) router.replace(result.path);
    });
  };

  const deleteDocument = () => {
    if (!selectedDocument) return;
    if (!confirm(`Delete "${selectedDocument.title ?? selectedDocument.brainId}"?`)) return;
    startTransition(async () => {
      const deletedId = selectedDocument.id;
      const result = await deleteGoatBrainDocumentAction(deletedId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const remaining = documents.filter((document) => document.id !== deletedId);
      const next =
        remaining.find((document) => document.folderPath === selectedFolder) ??
        remaining[0] ??
        null;
      onSelectDocumentId(next?.id ?? null);
      if (next) {
        onSelectFolder(next.folderPath);
        onExpandFolder(next.folderPath);
        router.replace(brainDocumentUrl(next));
      } else {
        router.replace(`/brain/${folderUrlSegments(selectedFolder)}`);
      }
    });
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-canvas">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-canvas/85 px-5 backdrop-blur-md">
        {selectedDocument ? (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px]">
              <FileText size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
              <span
                title={brainDocumentTreePath(selectedDocument)}
                className="min-w-0 truncate font-medium text-ink"
              >
                {selectedDocument.title ?? selectedDocument.brainId}
              </span>
              <span className="shrink-0 text-ink-subtle">
                {selectedDocument.folderPath}/{selectedDocument.brainId}.md
              </span>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={selectedDocument.folderPath}
                onChange={(event) => moveDocument(event.target.value)}
                disabled={isPending}
                className="h-8 max-w-[180px] rounded-md border border-border bg-surface px-2 text-[12.5px] outline-none focus:border-border-strong"
              >
                {folders.map((folder) => (
                  <option key={folder.path} value={folder.path}>
                    {folder.path}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-pressed={detailsOpen}
                aria-label="Toggle file details"
                title="Toggle file details"
                onClick={() => setDetailsOpen((open) => !open)}
                className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-150 ${
                  detailsOpen
                    ? "bg-surface-active text-ink"
                    : "text-ink-muted hover:bg-surface-subtle hover:text-ink"
                }`}
              >
                <Info size={15} strokeWidth={2} />
              </button>
              <button
                type="button"
                onClick={saveDocument}
                disabled={!dirty || isPending}
                className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Save size={14} strokeWidth={2} />
                Save
              </button>
              <button
                type="button"
                aria-label="Delete document"
                title="Delete document"
                onClick={deleteDocument}
                disabled={isPending}
                className="flex h-8 w-8 items-center justify-center rounded-md text-danger transition-colors duration-150 hover:bg-danger-bg disabled:opacity-45"
              >
                <Trash2 size={15} strokeWidth={2} />
              </button>
            </div>
          </>
        ) : (
          <span className="text-[12.5px] text-ink-muted">No file selected</span>
        )}
      </div>
      {selectedDocument && detailsOpen ? (
        <BrainDocumentDetails document={selectedDocument} />
      ) : null}

      {selectedDocument ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-6">
            <MarkdownGoatBrainEditor content={editorValue} onChange={setEditorValue} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-muted">
          Create or select a brain file to edit it.
        </div>
      )}
    </section>
  );
}

function BrainDocumentDetails({ document }: { document: GoatBrainDocumentView }) {
  return (
    <aside className="shrink-0 border-b border-border-subtle bg-surface-muted px-5 py-3">
      <div className="grid gap-4 text-[12px] leading-5 text-ink-muted md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-1">
          <DetailsRow label="Kind" value={document.kind} />
          <DetailsRow label="MIME" value={document.mimeType ?? "text/markdown"} />
          <DetailsRow label="Created" value={formatDateTime(document.createdAt)} />
          <DetailsRow label="Updated" value={formatDateTime(document.updatedAt)} />
        </div>
        <div className="min-w-0 space-y-1">
          <DetailsRow label="ID" value={document.brainId} />
          <DetailsRow label="Folder" value={document.folderPath} />
          <DetailsRow
            label="Related"
            value={document.related?.map((item) => item.target).join(", ") || "-"}
          />
          <DetailsRow
            label="Sources"
            value={document.sources?.map((item) => item.ref).join(", ") || "-"}
          />
        </div>
        <div className="min-w-0">
          <div className="mb-1 font-medium text-ink">Timeline</div>
          {document.kind !== "markdown" ? (
            <div>No timeline for this asset type.</div>
          ) : document.timeline.length > 0 ? (
            <div className="max-h-28 space-y-2 overflow-y-auto pr-2">
              {document.timeline.slice(0, 5).map((entry) => (
                <div key={`${entry.at}:${entry.body.slice(0, 24)}`} className="min-w-0">
                  <div className="font-medium text-ink">{entry.at}</div>
                  <div className="truncate">{entry.body}</div>
                </div>
              ))}
            </div>
          ) : (
            <div>No timeline entries.</div>
          )}
        </div>
      </div>
    </aside>
  );
}

function DetailsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-2">
      <span className="text-ink-subtle">{label}</span>
      <span className="truncate text-ink">{value}</span>
    </div>
  );
}

function groupRootNodes(nodes: BrainTreeNode[]) {
  const visibleNodes = nodes.filter(
    (node) => !HIDDEN_EMPTY_ROOT_FOLDERS.has(node.path) || hasDocumentDescendant(node),
  );
  const byPath = new Map(visibleNodes.map((node) => [node.path, node]));
  const groupedPaths = new Set(ROOT_FOLDER_GROUPS.flat());
  const groups = ROOT_FOLDER_GROUPS.map((paths) =>
    paths.flatMap((path) => {
      const node = byPath.get(path);
      return node ? [node] : [];
    }),
  );
  const remaining = visibleNodes.filter((node) => !groupedPaths.has(node.path));
  return remaining.length > 0 ? [...groups, remaining] : groups;
}

function firstNonEmptyGroupIndex(groups: BrainTreeNode[][]) {
  return groups.findIndex((group) => group.length > 0);
}

function hasDocumentDescendant(node: BrainTreeNode): boolean {
  return Boolean(node.document) || node.children.some(hasDocumentDescendant);
}

function buildBrainTree(
  folders: GoatBrainFolderView[],
  documents: GoatBrainDocumentView[],
  query: string,
) {
  const root: BrainTreeNode = { name: "", path: "", type: "folder", children: [] };
  const normalizedQuery = query.trim().toLowerCase();
  const visibleDocuments = normalizedQuery
    ? documents.filter((document) => {
        const path = brainDocumentTreePath(document).toLowerCase();
        const title = document.title?.toLowerCase() ?? "";
        return path.includes(normalizedQuery) || title.includes(normalizedQuery);
      })
    : documents;
  const visibleFolders = normalizedQuery
    ? folders.filter((folder) => folder.path.toLowerCase().includes(normalizedQuery))
    : folders;

  for (const folder of visibleFolders) {
    insertFolder(root, folder.path);
  }
  for (const document of visibleDocuments) {
    insertDocument(root, document);
  }
  sortTreeNodes(root.children);
  return root;
}

function insertFolder(root: BrainTreeNode, path: string) {
  const parts = path.split("/").filter(Boolean);
  let current = root;
  parts.forEach((part, index) => {
    const nextPath = parts.slice(0, index + 1).join("/");
    let child = current.children.find((item) => item.path === nextPath && item.type === "folder");
    if (!child) {
      child = { name: part, path: nextPath, type: "folder", children: [] };
      current.children.push(child);
    }
    current = child;
  });
}

function insertDocument(root: BrainTreeNode, document: GoatBrainDocumentView) {
  insertFolder(root, document.folderPath);
  const parts = brainDocumentTreePath(document).split("/").filter(Boolean);
  let current = root;
  parts.forEach((part, index) => {
    const path = parts.slice(0, index + 1).join("/");
    const isFile = index === parts.length - 1;
    let child = current.children.find((item) => item.path === path);
    if (!child) {
      child = { name: part, path, type: isFile ? "file" : "folder", children: [] };
      current.children.push(child);
    }
    if (isFile) child.document = document;
    current = child;
  });
}

function sortTreeNodes(nodes: BrainTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) sortTreeNodes(node.children);
}

function collectFolderPaths(node: BrainTreeNode): string[] {
  return node.children.flatMap((child) =>
    child.type === "folder" ? [child.path, ...collectFolderPaths(child)] : [],
  );
}

function FolderIcon({ path }: { path: string }) {
  const [root] = path.split("/");
  const className = "shrink-0 text-ink-muted";
  switch (root) {
    case "inbox":
      return <Inbox size={13} strokeWidth={1.75} className={className} />;
    case "companies":
      return <Building2 size={13} strokeWidth={1.75} className={className} />;
    case "decisions":
      return <BookOpen size={13} strokeWidth={1.75} className={className} />;
    case "ideas":
    case "insights":
      return <Lightbulb size={13} strokeWidth={1.75} className={className} />;
    case "people":
      return <Users size={13} strokeWidth={1.75} className={className} />;
    case "projects":
      return <BriefcaseBusiness size={13} strokeWidth={1.75} className={className} />;
    default:
      return <Folder size={13} strokeWidth={1.75} className={className} />;
  }
}

function FileIcon({ path }: { path: string }) {
  if (/\.(ts|tsx|js|jsx|json|css|sql|sh|py|rs|go)$/i.test(path)) {
    return <FileCode2 size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />;
  }
  return <FileText size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />;
}

function resolveInitialDocument(
  documents: GoatBrainDocumentView[],
  initialFolderPath: string | null,
  initialBrainId: string | null,
) {
  return (
    (initialBrainId
      ? documents.find(
          (document) =>
            document.brainId === initialBrainId &&
            (!initialFolderPath || document.folderPath === initialFolderPath),
        )
      : null) ??
    documents.find((document) => document.folderPath === initialFolderPath) ??
    documents[0] ??
    null
  );
}

function brainDocumentUrl(document: GoatBrainDocumentView) {
  return `/brain/${folderUrlSegments(document.folderPath)}/${encodeURIComponent(document.brainId)}`;
}

function brainDocumentTreePath(document: GoatBrainDocumentView) {
  return `${document.folderPath}/${document.brainId}.md`;
}

function folderUrlSegments(folderPath: string) {
  return folderPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function ancestorFolderPaths(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function withAncestorFolders(current: Set<string>, folderPath: string, includeFolder = false) {
  const next = new Set(current);
  const ancestors = ancestorFolderPaths(folderPath);
  for (const path of includeFolder ? ancestors : ancestors.slice(0, -1)) {
    next.add(path);
  }
  return next;
}

function folderViewFromRow(row: GoatBrainFolderRow): GoatBrainFolderView {
  return {
    id: row.id,
    path: row.path,
    source: row.source,
  };
}

function documentViewFromRow(row: GoatBrainDocumentRow): GoatBrainDocumentView {
  return {
    id: row.id,
    brainId: row.brain_id,
    folderPath: row.folder_path,
    title: row.title,
    content: row.content,
    body: row.body,
    timeline: normalizeTimeline(row.timeline),
    kind: normalizeKind(row.kind),
    mimeType: row.mime_type,
    originalFileName: row.original_file_name,
    assetStorageKey: row.asset_storage_key,
    related: normalizeRelations(row.related),
    sources: normalizeSources(row.sources),
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compareBrainDocuments(a: GoatBrainDocumentView, b: GoatBrainDocumentView) {
  const folder = a.folderPath.localeCompare(b.folderPath);
  if (folder !== 0) return folder;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function normalizeTimeline(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): GoatBrainDocumentView["timeline"] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.at !== "string" || typeof record.body !== "string") return [];
    return [{ at: record.at, body: record.body }];
  });
}

function normalizeKind(value: string): GoatBrainDocumentView["kind"] {
  if (value === "pdf" || value === "docx") return value;
  return "markdown";
}

function normalizeRelations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): GoatBrainDocumentView["related"] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.target !== "string") return [];
    return [
      {
        target: record.target,
        ...(typeof record.type === "string" ? { type: record.type } : {}),
      },
    ];
  });
}

function normalizeSources(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): GoatBrainDocumentView["sources"] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.ref !== "string") return [];
    return [
      {
        ref: record.ref,
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        ...(typeof record.capturedAt === "string" ? { capturedAt: record.capturedAt } : {}),
      },
    ];
  });
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
