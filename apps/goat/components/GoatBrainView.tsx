"use client";

import { normalizeGoatBrainBody } from "@opencompany/goat-brain/document";
import {
  evidenceLinkTargets,
  formatGoatBrainEvidenceLink,
  pageLinkTargets,
} from "@opencompany/goat-brain/inline-links";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import { useLiveQuery } from "@tanstack/react-db";
import {
  BookOpen,
  BriefcaseBusiness,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Ellipsis,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  History,
  Inbox,
  Lightbulb,
  Loader2,
  PanelRight,
  RotateCw,
  Search,
  Settings2,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatBrainActivity } from "@/components/GoatBrainActivity";
import { BrainAccessDialog } from "@/components/GoatBrainSwitcher";
import { useGoatNavInset } from "@/components/GoatNavInset";
import { MarkdownGoatBrainEditor } from "@/components/MarkdownGoatBrainEditor";
import { useHydrated } from "@/components/useHydrated";
import type { GoatBrainDocumentView, GoatBrainFolderView } from "@/lib/brain";
import {
  createGoatBrainDocumentAction,
  createGoatBrainFolderAction,
  deleteGoatBrainDocumentAction,
  renameGoatBrainDocumentAction,
  updateGoatBrainDocumentAction,
} from "@/lib/brain-actions";
import {
  buildGoatBrainDraftIngestStates,
  type GoatBrainDraftIngestState,
} from "@/lib/brain-activity";
import {
  createGoatCollections,
  type GoatBrainDocumentRow,
  type GoatBrainEdgeRow,
  type GoatBrainIngestJobRow,
  type GoatBrainSourceItemRow,
  type GoatBrainTimelineEntryRow,
} from "@/lib/task-collections";

type Props = {
  folders: GoatBrainFolderView[];
  documents: GoatBrainDocumentView[];
  initialFolderPath: string | null;
  initialBrainId: string | null;
  routeBrainId?: string | null;
};

type BrainTreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  children: BrainTreeNode[];
  document?: GoatBrainDocumentView;
};

type BrainGraphLink = {
  from: string;
  to: string;
  type: string;
  sourceKind: "relation" | "wiki_link";
};

const ROOT_FOLDER_GROUPS = [
  ["inbox"],
  ["people", "companies", "projects"],
  ["meetings", "research", "evidence"],
  ["decisions", "concepts"],
];
const HIDDEN_EMPTY_ROOT_FOLDERS = new Set<string>();
const AUTOSAVE_DELAY_MS = 1200;
const DEFAULT_BRAIN_FOLDERS = [
  "inbox",
  "people",
  "companies",
  "projects",
  "decisions",
  "meetings",
  "research",
  "concepts",
  "evidence",
];
const EMPTY_DRAFT_INGEST_STATES: ReadonlyMap<string, GoatBrainDraftIngestState> = new Map();

export function GoatBrainView({
  folders,
  documents,
  initialFolderPath,
  initialBrainId,
  routeBrainId,
}: Props) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <GoatBrainEditor
        folders={folders}
        documents={documents}
        initialFolderPath={initialFolderPath}
        initialBrainId={initialBrainId}
        routeBrainId={routeBrainId ?? null}
      />
    );
  }
  return (
    <LiveGoatBrainView
      folders={folders}
      documents={documents}
      initialFolderPath={initialFolderPath}
      initialBrainId={initialBrainId}
      routeBrainId={routeBrainId ?? null}
    />
  );
}

function LiveGoatBrainView({
  folders: initialFolders,
  documents: initialDocuments,
  initialFolderPath,
  initialBrainId,
  routeBrainId,
}: Props) {
  const { activeBrain } = useGoatAppData();
  const collections = useMemo(() => createGoatCollections(), []);
  const brainCollections = useMemo(
    () => collections.brainCollections(activeBrain?.id ?? "__no-brain__"),
    [activeBrain?.id, collections],
  );
  const { data: fileRows, isLoading: filesLoading } = useLiveQuery(
    (q) => q.from({ file: brainCollections.documents }),
    [brainCollections],
  );
  const { data: timelineRows } = useLiveQuery(
    (q) => q.from({ timeline: brainCollections.timelineEntries }),
    [brainCollections],
  );
  const { data: edgeRows } = useLiveQuery(
    (q) => q.from({ edge: brainCollections.edges }),
    [brainCollections],
  );
  const { data: ingestJobRows } = useLiveQuery(
    (q) => q.from({ job: brainCollections.ingestJobs }),
    [brainCollections],
  );
  const { data: captureSourceItemRows } = useLiveQuery(
    (q) => q.from({ item: collections.pendingBrainCaptureSourceItems }),
    [collections],
  );
  const documents = useMemo(() => {
    if (filesLoading && !fileRows?.length) return initialDocuments;
    const timelinesByDocument = groupTimelineRows(
      (timelineRows ?? []) as GoatBrainTimelineEntryRow[],
    );
    return ((fileRows ?? []) as GoatBrainDocumentRow[])
      .map((row) => documentViewFromRow(row, timelinesByDocument.get(row.id)))
      .toSorted(compareBrainDocuments);
  }, [fileRows, filesLoading, initialDocuments, timelineRows]);
  const folders = useMemo(() => {
    if (filesLoading && !fileRows?.length) return initialFolders;
    return deriveFolderViews(documents);
  }, [documents, fileRows?.length, filesLoading, initialFolders]);
  const draftIngestStatesByBrainId = useMemo(
    () =>
      buildGoatBrainDraftIngestStates(
        (ingestJobRows ?? []) as GoatBrainIngestJobRow[],
        (captureSourceItemRows ?? []) as GoatBrainSourceItemRow[],
      ),
    [captureSourceItemRows, ingestJobRows],
  );

  return (
    <GoatBrainEditor
      folders={folders}
      documents={documents}
      edgeRows={(edgeRows ?? []) as GoatBrainEdgeRow[]}
      draftIngestStatesByBrainId={draftIngestStatesByBrainId}
      initialFolderPath={initialFolderPath}
      initialBrainId={initialBrainId}
      routeBrainId={routeBrainId ?? null}
    />
  );
}

function GoatBrainEditor({
  folders,
  documents,
  edgeRows = [],
  draftIngestStatesByBrainId = EMPTY_DRAFT_INGEST_STATES,
  initialFolderPath,
  initialBrainId,
  routeBrainId,
}: Props & {
  edgeRows?: GoatBrainEdgeRow[];
  draftIngestStatesByBrainId?: ReadonlyMap<string, GoatBrainDraftIngestState>;
}) {
  const router = useRouter();
  const navInset = useGoatNavInset();
  const { activeBrain, workspace } = useGoatAppData();
  const selectedBrainId = routeBrainId ?? null;
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
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [isPending, startTransition] = useTransition();
  const [isDocPending, startDocTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [docPanelState, setDocPanelState] = useState<{
    docId: string | null;
    value: string;
    detailsOpen: boolean;
    timelineOpen: boolean;
  }>({
    docId: initialDocument?.id ?? null,
    value: documentEditorBody(initialDocument),
    detailsOpen: false,
    timelineOpen: false,
  });
  // Autosave bookkeeping that must survive re-renders without triggering them:
  // savedValue/savedHash come from our own last successful save (fresher than the
  // live collection right after saving), failedValue stops retry loops until the
  // draft changes again. Resets lazily on first access for a different document —
  // refs must not be written during render.
  const autosaveRef = useRef<{
    docId: string | null;
    savedValue: string | null;
    savedHash: string | null;
    failedValue: string | null;
  }>({ docId: initialDocument?.id ?? null, savedValue: null, savedHash: null, failedValue: null });
  const autosaveFor = useCallback((docId: string | null) => {
    if (autosaveRef.current.docId !== docId) {
      autosaveRef.current = { docId, savedValue: null, savedHash: null, failedValue: null };
    }
    return autosaveRef.current;
  }, []);

  const selectedDocument = useMemo(() => {
    if (!selectedDocumentId) return null;
    return documents.find((document) => document.id === selectedDocumentId) ?? null;
  }, [documents, selectedDocumentId]);
  const selectedDraftIngestState = selectedDocument
    ? (draftIngestStatesByBrainId.get(selectedDocument.brainId) ?? null)
    : null;
  if (docPanelState.docId !== (selectedDocument?.id ?? null)) {
    setDocPanelState({
      docId: selectedDocument?.id ?? null,
      value: documentEditorBody(selectedDocument),
      detailsOpen: false,
      timelineOpen: false,
    });
  }
  const editorValue = docPanelState.value;
  const selectedBody = documentEditorBody(selectedDocument);
  const dirty = Boolean(selectedDocument && editorValue !== selectedBody);
  const activeFolder = selectedDocument?.folderPath ?? selectedFolder;
  const activePath = selectedDocument ? brainDocumentTreePath(selectedDocument) : activeFolder;
  const tree = useMemo(
    () => buildBrainTree(folders, documents, query),
    [documents, folders, query],
  );
  const brainLinks = useMemo(
    () => brainLinkMap(folders, documents, selectedBrainId),
    [documents, folders, selectedBrainId],
  );
  const graphLinks = useMemo(() => buildGraphLinks(documents, edgeRows), [documents, edgeRows]);
  const rootGroups = useMemo(() => groupRootNodes(tree.children), [tree.children]);
  const hasRootNodes = rootGroups.some((group) => group.length > 0);
  const isSearching = Boolean(query.trim());
  const visibleExpandedPaths = useMemo(
    () => (isSearching ? new Set(collectFolderPaths(tree)) : expandedPaths),
    [expandedPaths, isSearching, tree],
  );

  const selectDocument = (document: GoatBrainDocumentView) => {
    saveRef.current(); // flush pending edits on the outgoing document
    setSelectedFolder(document.folderPath);
    setSelectedDocumentId(document.id);
    setExpandedPaths((current) => withAncestorFolders(current, document.folderPath));
    router.replace(brainDocumentUrl(document, selectedBrainId));
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
        toast.error(result.message);
        return;
      }
      const folderPath = result.path ?? path;
      setNewFolderPath("");
      setCreatingFolder(false);
      setSelectedFolder(folderPath);
      setExpandedPaths((current) => withAncestorFolders(current, folderPath, true));
      router.replace(brainFolderUrl(folderPath, selectedBrainId));
    });
  };

  const createDocument = () => {
    startTransition(async () => {
      const result = await createGoatBrainDocumentAction({
        folderPath: activeFolder,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      const document = result.document;
      if (document) {
        setSelectedFolder(document.folderPath);
        setSelectedDocumentId(document.id);
        setExpandedPaths((current) => withAncestorFolders(current, document.folderPath, true));
      }
      if (document) router.replace(brainDocumentUrl(document, selectedBrainId));
      else if (result.path) router.replace(brainFilePathUrl(result.path, selectedBrainId));
    });
  };

  // Saves never reseed the editor draft: keystrokes made while a save is in flight
  // must survive, and the live collection brings the fresh body/contentHash after.
  const saveDocument = () => {
    if (!selectedDocument || !dirty || isDocPending) return;
    const autosave = autosaveFor(selectedDocument.id);
    if (editorValue === autosave.savedValue) return;
    const documentId = selectedDocument.id;
    const body = editorValue;
    const expectedContentHash = autosave.savedHash ?? selectedDocument.contentHash;
    startDocTransition(async () => {
      const result = await updateGoatBrainDocumentAction({
        documentId,
        body,
        expectedContentHash,
      });
      if (autosaveRef.current.docId !== documentId) return;
      if (!result.ok) {
        autosaveRef.current.failedValue = body;
        toast.error(result.message);
        return;
      }
      autosaveRef.current.savedValue = body;
      autosaveRef.current.failedValue = null;
      if (result.document) autosaveRef.current.savedHash = result.document.contentHash;
    });
  };
  const saveRef = useRef(saveDocument);
  useEffect(() => {
    saveRef.current = saveDocument;
  });

  // Debounced autosave: fires once typing pauses; when an in-flight save finishes
  // (isDocPending flips), the effect re-arms so newer edits get their own save.
  useEffect(() => {
    if (!dirty || isDocPending) return;
    const autosave = autosaveFor(selectedDocumentId);
    if (editorValue === autosave.savedValue || editorValue === autosave.failedValue) return;
    const timer = setTimeout(() => saveRef.current(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autosaveFor, dirty, editorValue, isDocPending, selectedDocumentId]);

  // Rename deliberately does NOT reseed the editor draft (applyDocumentResult), so unsaved
  // body edits survive a title change; the live collection syncs title + contentHash after.
  const renameDocument = (title: string) => {
    if (!selectedDocument) return;
    const currentTitle = selectedDocument.title ?? selectedDocument.brainId;
    if (title === currentTitle) return;
    startDocTransition(async () => {
      const result = await renameGoatBrainDocumentAction({
        documentId: selectedDocument.id,
        title,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success("Renamed");
    });
  };

  const copyDocument = async () => {
    if (!selectedDocument) return;
    try {
      await navigator.clipboard.writeText(editorValue);
      toast.success("Copied markdown");
    } catch {
      toast.error("Could not copy to clipboard.");
    }
  };

  const deleteDocument = () => {
    if (!selectedDocument) return;
    if (!confirm(`Delete "${selectedDocument.title ?? selectedDocument.brainId}"?`)) return;
    startDocTransition(async () => {
      const deletedId = selectedDocument.id;
      const result = await deleteGoatBrainDocumentAction(deletedId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      const remaining = documents.filter((document) => document.id !== deletedId);
      const next =
        remaining.find((document) => document.folderPath === activeFolder) ?? remaining[0] ?? null;
      setSelectedDocumentId(next?.id ?? null);
      if (next) {
        setSelectedFolder(next.folderPath);
        setExpandedPaths((current) => withAncestorFolders(current, next.folderPath, true));
        router.replace(brainDocumentUrl(next, selectedBrainId));
      } else {
        router.replace(brainFolderUrl(activeFolder, selectedBrainId));
      }
    });
  };

  return (
    <main
      className="flex h-full min-h-0 w-full overflow-hidden bg-canvas text-ink"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          autosaveFor(selectedDocument?.id ?? null).failedValue = null;
          saveDocument();
        }
      }}
    >
      <aside className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-surface-muted">
        <div
          className={`flex h-9 shrink-0 items-center justify-between gap-2 ${navInset ? "pl-12" : "pl-4"} pr-2 pt-1`}
        >
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Brain
          </span>
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label="Create brain file"
              title="New file"
              onClick={createDocument}
              disabled={isPending}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-45"
            >
              <FilePlus2 size={15} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              aria-label="Create brain folder"
              title="New folder"
              aria-pressed={creatingFolder}
              onClick={() => setCreatingFolder((creating) => !creating)}
              disabled={isPending}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-45 ${
                creatingFolder
                  ? "bg-surface-active text-ink"
                  : "text-ink-subtle hover:bg-surface-hover hover:text-ink"
              }`}
            >
              <FolderPlus size={15} strokeWidth={1.8} />
            </button>
            {activeBrain ? <GoatBrainActivity brainRef={activeBrain.id} /> : null}
            {workspace.role === "admin" && activeBrain ? (
              <button
                type="button"
                aria-label={`Manage access to ${activeBrain.name}`}
                title="Brain access"
                onClick={() => setAccessDialogOpen(true)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <Settings2 size={15} strokeWidth={1.8} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="px-3 pb-1 pt-1">
          <label className="flex h-7 items-center gap-2 rounded-md border border-border bg-surface px-2 text-ink-muted transition-colors duration-150 focus-within:border-border-strong">
            <Search size={13} strokeWidth={1.8} className="shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search brain"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
            />
          </label>
        </div>

        <div role="tree" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {creatingFolder ? (
            <form
              className="mb-1 flex h-7 items-center gap-1.5 rounded-[5px] bg-surface pl-[25px] pr-2 ring-1 ring-border-strong"
              onSubmit={(event) => {
                event.preventDefault();
                createFolder();
              }}
            >
              <Folder size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
              <input
                autoFocus
                value={newFolderPath}
                onChange={(event) => setNewFolderPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setNewFolderPath("");
                    setCreatingFolder(false);
                  }
                }}
                onBlur={() => {
                  if (!newFolderPath.trim()) setCreatingFolder(false);
                }}
                placeholder="New folder"
                aria-label="New brain folder name"
                disabled={isPending}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-subtle"
              />
            </form>
          ) : null}
          {hasRootNodes ? (
            <div>
              {rootGroups.map((group, groupIndex) =>
                group.length > 0 ? (
                  <div key={group.map((node) => node.path).join("|")}>
                    {groupIndex > firstNonEmptyGroupIndex(rootGroups) ? (
                      <div className="h-2" />
                    ) : null}
                    {group.map((node) => (
                      <TreeItem
                        key={node.path}
                        node={node}
                        depth={0}
                        activePath={activePath}
                        expandedPaths={visibleExpandedPaths}
                        draftIngestStatesByBrainId={draftIngestStatesByBrainId}
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

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center border-b border-border-subtle">
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-5">
            {selectedDocument ? (
              <>
                <FileText size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
                <span
                  title={brainDocumentTreePath(selectedDocument)}
                  className="min-w-0 truncate text-[12.5px] font-medium text-ink"
                >
                  {selectedDocument.folderPath}/{selectedDocument.brainId}.md
                </span>
                <span className="hidden shrink-0 text-[12px] text-ink-subtle md:inline">
                  Updated {formatRelativeTime(selectedDocument.updatedAt)}
                </span>
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-1 pr-3">
            {selectedDocument ? (
              <>
                {isDocPending || dirty ? (
                  <span
                    role="status"
                    className="mr-1 shrink-0 text-[12px] text-ink-subtle transition-opacity duration-150"
                  >
                    {isDocPending ? "Saving…" : "Unsaved"}
                  </span>
                ) : null}
                {selectedDraftIngestState ? (
                  <BrainIngestStatusIcon state={selectedDraftIngestState} />
                ) : null}
                <button
                  type="button"
                  aria-label="Copy markdown"
                  title="Copy markdown"
                  onClick={copyDocument}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                >
                  <Copy size={14} strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  aria-pressed={docPanelState.detailsOpen}
                  aria-label="Toggle file details"
                  title="Toggle file details"
                  onClick={() =>
                    setDocPanelState((state) => ({ ...state, detailsOpen: !state.detailsOpen }))
                  }
                  className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                    docPanelState.detailsOpen
                      ? "bg-surface-active text-ink"
                      : "text-ink-muted hover:bg-surface-hover hover:text-ink"
                  }`}
                >
                  <PanelRight size={14} strokeWidth={1.9} />
                </button>
                <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                  <PopoverTrigger
                    aria-label="More actions"
                    title="More actions"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 data-[popup-open]:bg-surface-active data-[popup-open]:text-ink"
                  >
                    <Ellipsis size={15} strokeWidth={1.9} />
                  </PopoverTrigger>
                  <PopoverContent align="end" sideOffset={4} className="w-48 p-1">
                    <button
                      type="button"
                      aria-label="Toggle timeline"
                      onClick={() => {
                        setDocPanelState((state) => ({
                          ...state,
                          timelineOpen: !state.timelineOpen,
                        }));
                        setMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12.5px] text-ink transition-colors duration-150 hover:bg-surface-hover"
                    >
                      <History size={14} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
                      <span className="flex-1">
                        {docPanelState.timelineOpen ? "Hide timeline" : "Timeline"}
                      </span>
                      <span className="text-[11.5px] text-ink-subtle">
                        {selectedDocument.timeline.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label="Delete document"
                      disabled={isDocPending}
                      onClick={() => {
                        setMenuOpen(false);
                        deleteDocument();
                      }}
                      className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12.5px] text-danger transition-colors duration-150 hover:bg-danger-bg disabled:opacity-45"
                    >
                      <Trash2 size={14} strokeWidth={1.9} className="shrink-0" />
                      Delete
                    </button>
                  </PopoverContent>
                </Popover>
              </>
            ) : null}
          </div>
        </header>

        <BrainDocumentPanel
          key={selectedDocument?.id ?? "empty"}
          selectedDocument={selectedDocument}
          documents={documents}
          brainLinks={brainLinks}
          graphLinks={graphLinks}
          routeBrainId={selectedBrainId}
          editorValue={editorValue}
          detailsOpen={docPanelState.detailsOpen}
          timelineOpen={docPanelState.timelineOpen}
          isDocPending={isDocPending}
          onEditorChange={(value) => setDocPanelState((state) => ({ ...state, value }))}
          onRenameTitle={renameDocument}
        />
      </div>
      {accessDialogOpen && activeBrain ? (
        <BrainAccessDialog
          brain={activeBrain}
          workspace={workspace}
          onClose={() => setAccessDialogOpen(false)}
        />
      ) : null}
    </main>
  );
}

function TreeItem({
  node,
  depth,
  activePath,
  expandedPaths,
  draftIngestStatesByBrainId,
  onSelect,
  onToggleFolder,
}: {
  node: BrainTreeNode;
  depth: number;
  activePath: string;
  expandedPaths: Set<string>;
  draftIngestStatesByBrainId: ReadonlyMap<string, GoatBrainDraftIngestState>;
  onSelect: (document: GoatBrainDocumentView) => void;
  onToggleFolder: (path: string) => void;
}) {
  const active = node.path === activePath;
  const expanded = node.type === "folder" && expandedPaths.has(node.path);
  const showChildren = node.type === "folder" && expanded;
  const paddingStyle = { paddingLeft: `${6 + depth * 14}px` };
  const draftIngestState =
    node.type === "file" && node.document
      ? (draftIngestStatesByBrainId.get(node.document.brainId) ?? null)
      : null;

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
        className={`group flex h-7 w-full items-center gap-1.5 rounded-[5px] pr-2 text-left text-[13px] leading-5 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
          active
            ? "bg-surface-active text-ink"
            : "text-ink/85 hover:bg-surface-hover hover:text-ink"
        }`}
        style={paddingStyle}
      >
        {node.type === "folder" ? (
          expanded ? (
            <ChevronDown size={13} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
          ) : (
            <ChevronRight size={13} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
          )
        ) : (
          <span className="h-[13px] w-[13px] shrink-0" />
        )}
        {node.type === "folder" ? <FolderIcon path={node.path} /> : <FileIcon path={node.path} />}
        {node.type === "file" ? <TreeIngestStatusSlot state={draftIngestState} /> : null}
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {showChildren
        ? node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              expandedPaths={expandedPaths}
              draftIngestStatesByBrainId={draftIngestStatesByBrainId}
              onSelect={onSelect}
              onToggleFolder={onToggleFolder}
            />
          ))
        : null}
    </div>
  );
}

function TreeIngestStatusSlot({ state }: { state: GoatBrainDraftIngestState | null }) {
  return (
    <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
      {state ? <BrainIngestStatusIcon state={state} compact /> : null}
    </span>
  );
}

function BrainDocumentPanel({
  selectedDocument,
  documents,
  brainLinks,
  graphLinks,
  routeBrainId,
  editorValue,
  detailsOpen,
  timelineOpen,
  isDocPending,
  onEditorChange,
  onRenameTitle,
}: {
  selectedDocument: GoatBrainDocumentView | null;
  documents: GoatBrainDocumentView[];
  brainLinks: Record<string, string>;
  graphLinks: BrainGraphLink[];
  routeBrainId: string | null;
  editorValue: string;
  detailsOpen: boolean;
  timelineOpen: boolean;
  isDocPending: boolean;
  onEditorChange: (value: string) => void;
  onRenameTitle: (title: string) => void;
}) {
  if (!selectedDocument) {
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-muted">
          Create or select a brain file to edit it.
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      {timelineOpen ? <BrainDocumentTimeline document={selectedDocument} /> : null}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-8 pb-24 pt-12">
            <BrainTitleEditor
              document={selectedDocument}
              disabled={isDocPending}
              onRename={onRenameTitle}
            />
            <div className="mt-6">
              <MarkdownGoatBrainEditor
                content={editorValue}
                onChange={onEditorChange}
                brainLinks={brainLinks}
              />
            </div>
          </div>
        </div>

        {detailsOpen ? (
          <BrainMetadataSidebar
            document={selectedDocument}
            documents={documents}
            graphLinks={graphLinks}
            routeBrainId={routeBrainId}
          />
        ) : null}
      </div>
    </section>
  );
}

function BrainMetadataSidebar({
  document,
  documents,
  graphLinks,
  routeBrainId,
}: {
  document: GoatBrainDocumentView;
  documents: GoatBrainDocumentView[];
  graphLinks: BrainGraphLink[];
  routeBrainId: string | null;
}) {
  const documentsByBrainId = useMemo(
    () => new Map(documents.map((item) => [item.brainId, item])),
    [documents],
  );
  const outgoingLinks = graphLinks.filter((link) => link.from === document.brainId);
  const backlinks = graphLinks.filter((link) => link.to === document.brainId);

  return (
    <aside
      aria-label="File details"
      className="flex w-72 shrink-0 flex-col gap-6 overflow-y-auto border-l border-border-subtle px-4 py-5"
    >
      <section className="flex flex-col gap-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          Properties
        </h2>
        <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-x-2 gap-y-2 text-[12px] leading-5">
          <MetadataRow label="Type" value={document.type} />
          {document.kind === "evidence" ? <MetadataRow label="Kind" value="evidence" /> : null}
          <MetadataRow label="Created" value={formatDateTime(document.createdAt)} />
          <MetadataRow label="Updated" value={formatDateTime(document.updatedAt)} />
          <span className="text-ink-subtle">ID</span>
          <code
            title={document.brainId}
            className="min-w-0 truncate rounded-sm bg-surface-muted px-1 py-0.5 text-[11px] text-ink-muted"
          >
            {document.brainId}
          </code>
          <MetadataRow label="Aliases" value={document.aliases.join(", ") || "-"} />
          <MetadataRow
            label="Sources"
            value={document.sources?.map((item) => item.ref).join(", ") || "-"}
          />
        </div>
      </section>

      <SidebarTimelineSection document={document} />

      <GraphLinksList
        title="Outgoing"
        links={outgoingLinks}
        documentsByBrainId={documentsByBrainId}
        empty="No outgoing links."
        direction="out"
        routeBrainId={routeBrainId}
      />
      <GraphLinksList
        title="Backlinks"
        links={backlinks}
        documentsByBrainId={documentsByBrainId}
        empty="No backlinks."
        direction="in"
        routeBrainId={routeBrainId}
      />
    </aside>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-ink-subtle">{label}</span>
      <span title={value} className="min-w-0 truncate text-ink">
        {value}
      </span>
    </>
  );
}

// The page title as an in-place editor: commit on Enter/blur, revert on Escape. Resyncs when
// the document's title changes underneath it (live collection updates after a rename).
function BrainTitleEditor({
  document,
  disabled,
  onRename,
}: {
  document: GoatBrainDocumentView;
  disabled: boolean;
  onRename: (title: string) => void;
}) {
  const title = document.title ?? document.brainId;
  const [draft, setDraft] = useState(title);
  const [prevTitle, setPrevTitle] = useState(title);
  const skipCommitRef = useRef(false);
  if (prevTitle !== title) {
    setPrevTitle(title);
    setDraft(title);
  }

  const commit = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    const next = draft.trim();
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    onRename(next);
  };

  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          skipCommitRef.current = true;
          setDraft(title);
          event.currentTarget.blur();
        }
      }}
      disabled={disabled}
      aria-label="Page title"
      placeholder="Untitled"
      className="w-full bg-transparent text-[32px] font-bold leading-[1.15] tracking-tight text-ink outline-none placeholder:text-ink-subtle disabled:opacity-60"
    />
  );
}

// Collapsible timeline in the file-details sidebar: what happened on this document, newest first.
function SidebarTimelineSection({ document }: { document: GoatBrainDocumentView }) {
  const [open, setOpen] = useState(false);
  const entries = useMemo(
    () =>
      [...document.timeline].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    [document.timeline],
  );

  return (
    <section className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mb-1 flex w-full items-center justify-between gap-2 rounded-sm text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      >
        <h2 className="text-[12px] font-semibold text-ink">Timeline</h2>
        <span className="flex items-center gap-1 text-[12px] text-ink-subtle">
          {entries.length}
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={`transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
          />
        </span>
      </button>
      {open ? (
        entries.length > 0 ? (
          <ol className="max-h-72 space-y-3 overflow-y-auto pr-1">
            {entries.map((entry, index) => (
              <li
                key={`${entry.evidenceId}:${entry.at}:${index}:${entry.body.slice(0, 24)}`}
                className="min-w-0 text-[12px] leading-5"
              >
                <time dateTime={entry.at} className="block text-ink-subtle">
                  {formatDateTime(entry.at)}
                </time>
                <p className="mt-0.5 min-w-0 whitespace-pre-wrap text-ink-muted">{entry.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[12px] text-ink-subtle">No timeline entries.</p>
        )
      ) : null}
    </section>
  );
}

function GraphLinksList({
  title,
  links,
  documentsByBrainId,
  empty,
  direction,
  routeBrainId,
}: {
  title: string;
  links: BrainGraphLink[];
  documentsByBrainId: Map<string, GoatBrainDocumentView>;
  empty: string;
  direction: "out" | "in";
  routeBrainId: string | null | undefined;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold text-ink">{title}</h2>
        <span className="text-[12px] text-ink-subtle">{links.length}</span>
      </div>
      {links.length > 0 ? (
        <ol className="max-h-32 space-y-1 overflow-y-auto pr-1">
          {links.map((link) => {
            const peerId = direction === "out" ? link.to : link.from;
            const peer = documentsByBrainId.get(peerId);
            return (
              <li
                key={`${link.sourceKind}:${link.type}:${link.from}:${link.to}`}
                className="min-w-0"
              >
                {peer ? (
                  <Link
                    href={brainDocumentUrl(peer, routeBrainId)}
                    className="flex min-w-0 items-center gap-1.5 rounded-sm text-ink-muted hover:text-ink"
                  >
                    <span className="truncate">{peer.title || peer.brainId}</span>
                    <span className="shrink-0 text-ink-subtle">
                      {direction === "out" ? "->" : "<-"} {link.type}
                    </span>
                  </Link>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
                    <span className="truncate">{peerId}</span>
                    <span className="shrink-0 text-ink-subtle">
                      {direction === "out" ? "->" : "<-"} {link.type}
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-[12px] text-ink-subtle">{empty}</p>
      )}
    </section>
  );
}

function BrainDocumentTimeline({ document }: { document: GoatBrainDocumentView }) {
  const entries = [...document.timeline].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
  return (
    <aside className="shrink-0 border-b border-border-subtle bg-surface-muted px-5 py-3">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <History size={14} strokeWidth={2} className="shrink-0 text-ink-muted" />
            <h2 className="truncate text-[12.5px] font-semibold text-ink">Timeline</h2>
          </div>
          <span className="shrink-0 text-[12px] text-ink-subtle">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </span>
        </div>
        {document.format !== "markdown" ? (
          <p className="text-[12.5px] text-ink-muted">No timeline for this asset type.</p>
        ) : entries.length > 0 ? (
          <ol className="max-h-56 space-y-3 overflow-y-auto pr-2">
            {entries.map((entry, index) => (
              <li
                key={`${entry.evidenceId}:${entry.at}:${index}:${entry.body.slice(0, 24)}`}
                className="grid grid-cols-[132px_minmax(0,1fr)] gap-3 text-[12.5px] leading-5"
              >
                <div className="min-w-0">
                  <time dateTime={entry.at} className="block text-ink-subtle">
                    {formatDateTime(entry.at)}
                  </time>
                  <code className="mt-1 block truncate rounded-sm bg-surface px-1 py-0.5 text-[11px] text-ink-muted">
                    {formatGoatBrainEvidenceLink(entry.evidenceId)}
                  </code>
                </div>
                <p className="min-w-0 whitespace-pre-wrap text-ink-muted">{entry.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[12.5px] text-ink-muted">No timeline entries.</p>
        )}
      </div>
    </aside>
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
  // Merged docs are tombstones whose content lives in the page they were
  // merged into; hide them from the tree like the CLI's default list does.
  const listedDocuments = documents.filter((document) => document.status !== "merged");
  const visibleDocuments = normalizedQuery
    ? listedDocuments.filter((document) => {
        const path = brainDocumentTreePath(document).toLowerCase();
        const title = document.title?.toLowerCase() ?? "";
        return path.includes(normalizedQuery) || title.includes(normalizedQuery);
      })
    : listedDocuments;
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
      return <Inbox size={14} strokeWidth={1.8} className={className} />;
    case "companies":
      return <Building2 size={14} strokeWidth={1.8} className={className} />;
    case "decisions":
      return <BookOpen size={14} strokeWidth={1.8} className={className} />;
    case "concepts":
      return <Lightbulb size={14} strokeWidth={1.8} className={className} />;
    case "people":
      return <Users size={14} strokeWidth={1.8} className={className} />;
    case "projects":
      return <BriefcaseBusiness size={14} strokeWidth={1.8} className={className} />;
    case "evidence":
      return <History size={14} strokeWidth={1.8} className={className} />;
    default:
      return <Folder size={14} strokeWidth={1.8} className={className} />;
  }
}

function FileIcon({ path }: { path: string }) {
  if (/\.(ts|tsx|js|jsx|json|css|sql|sh|py|rs|go)$/i.test(path)) {
    return <FileCode2 size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />;
  }
  return <FileText size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />;
}

function BrainIngestStatusIcon({
  state,
  compact = false,
}: {
  state: GoatBrainDraftIngestState;
  compact?: boolean;
}) {
  const Icon =
    state.kind === "failed" ? CircleAlert : state.kind === "retrying" ? RotateCw : Loader2;
  const label = draftIngestStateLabel(state);
  const colorClass =
    state.kind === "failed"
      ? "text-danger"
      : state.kind === "retrying"
        ? "text-amber-600"
        : "text-ink-muted";
  const animationClass = state.kind === "queued" || state.kind === "running" ? "animate-spin" : "";

  return (
    <span
      role={compact ? "img" : "status"}
      aria-label={label}
      title={label}
      className={`flex shrink-0 items-center justify-center ${compact ? "h-[14px] w-[14px]" : "mr-1 h-5 w-5"} ${colorClass}`}
    >
      <Icon size={compact ? 12 : 14} strokeWidth={compact ? 2.1 : 1.9} className={animationClass} />
    </span>
  );
}

function draftIngestStateLabel(state: GoatBrainDraftIngestState) {
  const title = state.title ? `: ${state.title}` : "";
  if (state.kind === "failed") {
    return `Brain filing failed${state.detail ? `: ${state.detail}` : title}`;
  }
  if (state.kind === "retrying") {
    return `Retrying brain filing${title}`;
  }
  if (state.kind === "queued") {
    return `Waiting to file capture into brain${title}`;
  }
  return `Filing capture into brain${title}`;
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

function brainDocumentUrl(document: GoatBrainDocumentView, routeBrainId?: string | null) {
  return brainPathUrl([...folderPathSegments(document.folderPath), document.brainId], routeBrainId);
}

function brainFolderUrl(folderPath: string, routeBrainId?: string | null) {
  return brainPathUrl(folderPathSegments(folderPath), routeBrainId);
}

function brainFilePathUrl(path: string, routeBrainId?: string | null) {
  if (path.startsWith("/brain/")) return path;
  const withoutExtension = path.replace(/\.md$/i, "");
  return brainPathUrl(folderPathSegments(withoutExtension), routeBrainId);
}

function brainDocumentTreePath(document: GoatBrainDocumentView) {
  return `${document.folderPath}/${document.brainId}.md`;
}

function brainLinkMap(
  folders: GoatBrainFolderView[],
  documents: GoatBrainDocumentView[],
  routeBrainId?: string | null,
) {
  const links: Record<string, string> = {};
  for (const folder of folders) {
    const href = brainFolderUrl(folder.path, routeBrainId);
    addBrainLinkTarget(links, folder.path, href);
    addBrainLinkTarget(links, `folder:${folder.path}`, href);
    addBrainLinkTarget(links, `wiki/${folder.path}`, href);
  }
  for (const document of documents) {
    const href = brainDocumentUrl(document, routeBrainId);
    const folderTarget = `${document.folderPath}/${document.brainId}`;
    addBrainLinkTarget(links, document.brainId, href);
    addBrainLinkTarget(links, folderTarget, href);
    addBrainLinkTarget(links, `${folderTarget}.md`, href);
    addBrainLinkTarget(links, `wiki/${folderTarget}`, href);
    addBrainLinkTarget(links, `wiki/${folderTarget}.md`, href);
    if (document.kind === "evidence") links[`evidence:${document.brainId}`] = href;
  }
  return links;
}

function addBrainLinkTarget(links: Record<string, string>, target: string, href: string) {
  links[target] = href;
  links[`page:${target}`] = href;
}

function brainPathUrl(pathSegments: string[], routeBrainId?: string | null) {
  const segments = routeBrainId ? [routeBrainId, ...pathSegments] : pathSegments;
  return `/brain/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function folderPathSegments(folderPath: string) {
  return folderPath.split("/").filter(Boolean);
}

function buildGraphLinks(
  documents: GoatBrainDocumentView[],
  edgeRows: GoatBrainEdgeRow[] = [],
): BrainGraphLink[] {
  if (edgeRows.length > 0) {
    return edgeRows.map((row) => ({
      from: row.from_brain_id,
      to: row.to_brain_id,
      type: row.relation_type,
      sourceKind: row.source_kind,
    }));
  }
  const links = new Map<string, BrainGraphLink>();
  const add = (link: BrainGraphLink) => {
    if (link.from === link.to) return;
    links.set(`${link.sourceKind}:${link.type}:${link.from}:${link.to}`, link);
  };

  for (const document of documents) {
    for (const relation of document.relations ?? []) {
      add({
        from: document.brainId,
        to: relation.to,
        type: relation.type || "related",
        sourceKind: "relation",
      });
    }
    const inlineLinkText = documentInlineLinkText(document);
    for (const target of pageLinkTargets(inlineLinkText)) {
      add({
        from: document.brainId,
        to: target,
        type: "wiki_link",
        sourceKind: "wiki_link",
      });
    }
    for (const target of evidenceLinkTargets(inlineLinkText)) {
      add({
        from: document.brainId,
        to: target,
        type: "cites",
        sourceKind: "wiki_link",
      });
    }
  }

  return [...links.values()].sort((a, b) =>
    `${a.from}:${a.to}:${a.type}:${a.sourceKind}`.localeCompare(
      `${b.from}:${b.to}:${b.type}:${b.sourceKind}`,
    ),
  );
}

function documentInlineLinkText(document: GoatBrainDocumentView) {
  return [documentEditorBody(document), ...document.timeline.map((entry) => entry.body)].join(
    "\n\n",
  );
}

function documentEditorBody(document: GoatBrainDocumentView | null | undefined) {
  return document ? normalizeGoatBrainBody(document.body) : "";
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

function documentViewFromRow(
  row: GoatBrainDocumentRow,
  timelineRows?: GoatBrainTimelineEntryRow[],
): GoatBrainDocumentView {
  const parsed = parseBrainFrontmatter(row.content);
  const path = `${row.folder_path}/${row.brain_id}.md`;
  return {
    id: row.id,
    brainId: row.brain_id,
    folderPath: row.folder_path,
    path,
    title: row.title ?? row.brain_id,
    content: row.content,
    body: normalizeGoatBrainBody(row.body),
    timeline: timelineRows ? timelineRowsFromRows(timelineRows) : normalizeTimeline(row.timeline),
    format: normalizeFormat(row.format),
    mimeType: row.mime_type ?? "text/markdown",
    originalFileName: row.original_file_name,
    assetStorageKey: row.asset_storage_key,
    relations: normalizeRelations(row.relations),
    sources: normalizeSources(row.sources),
    kind: normalizeDocumentKind(row.kind),
    type: normalizeEntityType(row.entity_type),
    status: normalizeStatus(row.status),
    aliases: normalizeStringArray(row.aliases),
    tags: normalizeStringArray(parsed.tags),
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    parseError: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function groupTimelineRows(rows: GoatBrainTimelineEntryRow[]) {
  const byDocument = new Map<string, GoatBrainTimelineEntryRow[]>();
  for (const row of rows) {
    const current = byDocument.get(row.document_id) ?? [];
    current.push(row);
    byDocument.set(row.document_id, current);
  }
  for (const [documentId, values] of byDocument) {
    byDocument.set(
      documentId,
      values.toSorted((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    );
  }
  return byDocument;
}

function timelineRowsFromRows(
  rows: GoatBrainTimelineEntryRow[],
): GoatBrainDocumentView["timeline"] {
  return rows.map((row) => ({
    evidenceId: row.evidence_id,
    at: row.at,
    body: [row.summary, row.detail, sourceLine(row)].filter(Boolean).join("\n\n"),
  }));
}

function sourceLine(row: GoatBrainTimelineEntryRow) {
  if (!row.source_ref) return "";
  return `Source: ${row.source_title ? `${row.source_title} (${row.source_ref})` : row.source_ref}`;
}

function compareBrainDocuments(a: GoatBrainDocumentView, b: GoatBrainDocumentView) {
  const folder = a.folderPath.localeCompare(b.folderPath);
  if (folder !== 0) return folder;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function deriveFolderViews(documents: GoatBrainDocumentView[]): GoatBrainFolderView[] {
  const byPath = new Map<string, GoatBrainFolderView>();
  const zero = new Date(0).toISOString();
  for (const folder of DEFAULT_BRAIN_FOLDERS) {
    byPath.set(folder, {
      id: `folder:${folder}`,
      path: folder,
      name: folderName(folder),
      source: "system",
      createdAt: zero,
      updatedAt: zero,
    });
  }
  for (const document of documents) {
    for (const path of ancestorFolderPaths(document.folderPath)) {
      const existing = byPath.get(path);
      byPath.set(path, {
        id: `folder:${path}`,
        path,
        name: folderName(path),
        source: DEFAULT_BRAIN_FOLDERS.includes(path) ? "system" : "custom",
        createdAt: existing?.createdAt ?? document.createdAt,
        updatedAt:
          existing && existing.updatedAt > document.updatedAt
            ? existing.updatedAt
            : document.updatedAt,
      });
    }
  }
  return [...byPath.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

function folderName(folderPath: string) {
  const name = folderPath.split("/").filter(Boolean).at(-1) ?? folderPath;
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function normalizeTimeline(
  value: GoatBrainDocumentRow["timeline"],
): GoatBrainDocumentView["timeline"] {
  return Array.isArray(value)
    ? value.flatMap((entry): GoatBrainDocumentView["timeline"] => {
        const evidenceId = entry.evidenceId ?? entry.evidence_id;
        return entry.at && entry.body
          ? [{ evidenceId: evidenceId ?? "", at: entry.at, body: entry.body }]
          : [];
      })
    : [];
}

function normalizeFormat(value: string): GoatBrainDocumentView["format"] {
  if (value === "pdf" || value === "docx") return value;
  return "markdown";
}

function normalizeDocumentKind(value: string): GoatBrainDocumentView["kind"] {
  return value === "evidence" ? "evidence" : "page";
}

function normalizeEntityType(value: string): GoatBrainDocumentView["type"] {
  if (
    value === "person" ||
    value === "company" ||
    value === "media" ||
    value === "analysis" ||
    value === "concept" ||
    value === "email" ||
    value === "writing" ||
    value === "note" ||
    value === "project" ||
    value === "source"
  ) {
    return value;
  }
  return "note";
}

function normalizeStatus(value: string): GoatBrainDocumentView["status"] {
  if (value === "active" || value === "archived" || value === "merged") return value;
  return "draft";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeRelations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): GoatBrainDocumentView["relations"] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.to !== "string") return [];
    return [
      {
        type: typeof record.type === "string" ? record.type : "related",
        to: record.to,
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

function parseBrainFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content.replace(/\r\n/g, "\n"));
  if (!match?.[1]) return {};
  const tagsMatch = /^tags:\n((?:\s+- .+\n?)+)/m.exec(match[1]);
  if (!tagsMatch?.[1]) return {};
  return {
    tags: tagsMatch[1]
      .split("\n")
      .map((line) => line.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean),
  };
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  const elapsedMs = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || elapsedMs < 30_000) return "just now";

  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}
