"use client";

import {
  GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER,
  normalizeGoatBrainCompiledTruth,
  parseGoatBrainDocument,
} from "@opencompany/goat-brain/document";
import {
  compareGoatBrainFolderPaths,
  goatBrainFolderSourceForPath,
  goatBrainRootFolderGroup,
} from "@opencompany/goat-brain/folders";
import {
  evidenceLinkTargets,
  formatGoatBrainEvidenceLink,
  pageLinkTargets,
  sourceLinkTargets,
} from "@opencompany/goat-brain/inline-links";
import {
  isGoatBrainSkillFolder,
  serializeGoatBrainSkillMarkdown,
} from "@opencompany/goat-brain/skills";
import { isGoatBrainWorkflowFolder } from "@opencompany/goat-brain/workflows";
import {
  DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN,
  GOAT_WORKFLOW_MODEL_OPTIONS,
} from "@/lib/workflow-model-options";

const DEFAULT_WORKFLOW_MODEL_LABEL =
  GOAT_WORKFLOW_MODEL_OPTIONS.find((option) => option.token === DEFAULT_GOAT_WORKFLOW_MODEL_TOKEN)
    ?.label ?? "Kimi K2.6";

import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import { useLiveQuery } from "@tanstack/react-db";
import {
  BookOpen,
  Brain,
  BriefcaseBusiness,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CirclePause,
  Copy,
  Ellipsis,
  FileCode2,
  FilePlus2,
  FileText,
  FileUp,
  Folder,
  FolderPlus,
  History,
  Inbox,
  LayoutDashboard,
  Lightbulb,
  Loader2,
  PanelRight,
  Pencil,
  RotateCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  Workflow as WorkflowIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { type GoatBrainSummaryView, useGoatAppData } from "@/components/GoatAppDataProvider";
import { GoatBrainActivity } from "@/components/GoatBrainActivity";
import { GoatBrainImport } from "@/components/GoatBrainImport";
import { GoatBrainOverview } from "@/components/GoatBrainOverview";
import { useGoatNavInset } from "@/components/GoatNavInset";
import { MarkdownGoatBrainEditor } from "@/components/MarkdownGoatBrainEditor";
import { useHydrated } from "@/components/useHydrated";
import type { GoatBrainDocumentView, GoatBrainFolderView } from "@/lib/brain";
import {
  createGoatBrainDocumentAction,
  createGoatBrainFolderAction,
  createGoatBrainSkillAction,
  createGoatBrainWorkflowAction,
  deleteGoatBrainDocumentAction,
  deleteGoatBrainFolderAction,
  renameGoatBrainDocumentAction,
  renameGoatBrainFolderAction,
  replaceGoatBrainAssetAction,
  updateGoatBrainDocumentAction,
  updateGoatBrainSkillAction,
  updateGoatBrainWorkflowAction,
  uploadGoatBrainAssetAction,
} from "@/lib/brain-actions";
import {
  buildGoatBrainDraftIngestStates,
  type GoatBrainDraftIngestState,
} from "@/lib/brain-activity";
import {
  BRAIN_ASSET_ACCEPT,
  uploadBrainAssetBlob,
  validateBrainAssetFile,
} from "@/lib/brain-asset-upload";
import type { GoatBrainOverviewStats } from "@/lib/brain-overview";
import { isExternalHref, sourceHrefForRef } from "@/lib/brain-source-links";
import {
  createGoatCollections,
  type GoatBrainDocumentRow,
  type GoatBrainEdgeRow,
  type GoatBrainFolderRow,
  type GoatBrainIngestJobRow,
  type GoatBrainSourceItemRow,
  type GoatBrainTimelineEntryRow,
} from "@/lib/task-collections";

type Props = {
  brainRef: string | null;
  brain: GoatBrainSummaryView | null;
  folders: GoatBrainFolderView[];
  documents: GoatBrainDocumentView[];
  initialFolderPath: string | null;
  initialBrainId: string | null;
  routeBrainId?: string | null;
  initialOverview?: boolean;
  overviewStats?: GoatBrainOverviewStats | null;
  initialDataLoaded?: boolean;
};

type BrainTreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  children: BrainTreeNode[];
  folder?: GoatBrainFolderView;
  document?: GoatBrainDocumentView;
};

type BrainGraphLink = {
  from: string;
  to: string;
  type: string;
  sourceKind: "relation" | "wiki_link";
};

type ResolvedBrainGraphLink = BrainGraphLink & {
  direction: "out" | "in";
  peer: GoatBrainDocumentView;
  peerId: string;
};

type EvidenceGraphItem = {
  peer: GoatBrainDocumentView;
  relationTypes: string[];
};

type FolderDialogState =
  | { kind: "create"; initialPath?: string }
  | { kind: "rename"; path: string };

type BrainContextMenuState = {
  x: number;
  y: number;
  fileFolderPath: string;
  folderParentPath: string;
};

const HIDDEN_EMPTY_ROOT_FOLDERS = new Set<string>();
const AUTOSAVE_DELAY_MS = 1200;
const EMPTY_DRAFT_INGEST_STATES: ReadonlyMap<string, GoatBrainDraftIngestState> = new Map();
const EMPTY_OVERVIEW_STATS: GoatBrainOverviewStats = {
  windowStartedAt: "9999-12-31T23:59:59.999Z",
  itemsAddedLast7Days: 0,
  retrievalsLast7Days: 0,
  activeSources: 0,
};

export function GoatBrainView({
  brainRef,
  brain,
  folders,
  documents,
  initialFolderPath,
  initialBrainId,
  routeBrainId,
  initialOverview = false,
  overviewStats = null,
  initialDataLoaded = true,
}: Props) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <GoatBrainEditor
        brainRef={brainRef}
        brain={brain}
        folders={folders}
        documents={documents}
        initialFolderPath={initialFolderPath}
        initialBrainId={initialBrainId}
        routeBrainId={routeBrainId ?? null}
        initialOverview={initialOverview}
        overviewStats={overviewStats}
        initialDataLoaded={initialDataLoaded}
        brainDataLoading={!initialDataLoaded}
      />
    );
  }
  return (
    <LiveGoatBrainView
      brainRef={brainRef}
      brain={brain}
      folders={folders}
      documents={documents}
      initialFolderPath={initialFolderPath}
      initialBrainId={initialBrainId}
      routeBrainId={routeBrainId ?? null}
      initialOverview={initialOverview}
      overviewStats={overviewStats}
      initialDataLoaded={initialDataLoaded}
    />
  );
}

function LiveGoatBrainView({
  brainRef,
  brain,
  folders: initialFolders,
  documents: initialDocuments,
  initialFolderPath,
  initialBrainId,
  routeBrainId,
  initialOverview = false,
  overviewStats = null,
  initialDataLoaded = true,
}: Props) {
  const collections = useMemo(() => createGoatCollections(), []);
  const brainCollections = useMemo(
    () => collections.brainCollections(brainRef ?? "__no-brain__"),
    [brainRef, collections],
  );
  const { data: fileRows, isLoading: filesLoading } = useLiveQuery(
    (q) => q.from({ file: brainCollections.documents }),
    [brainCollections],
  );
  const { data: folderRows, isLoading: foldersLoading } = useLiveQuery(
    (q) => q.from({ folder: brainCollections.folders }),
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
    if (filesLoading && !fileRows?.length) return initialDocuments.filter(isKnowledgeDocument);
    const timelinesByDocument = groupTimelineRows(
      (timelineRows ?? []) as GoatBrainTimelineEntryRow[],
    );
    return ((fileRows ?? []) as GoatBrainDocumentRow[])
      .map((row) => documentViewFromRow(row, timelinesByDocument.get(row.id)))
      .filter(isKnowledgeDocument)
      .toSorted(compareBrainDocuments);
  }, [fileRows, filesLoading, initialDocuments, timelineRows]);
  const folders = useMemo(() => {
    if (
      (filesLoading && !fileRows?.length) ||
      (foldersLoading && !folderRows?.length && initialFolders.length > 0)
    ) {
      return initialFolders.filter(isKnowledgeFolderView);
    }
    return deriveFolderViews(documents, (folderRows ?? []) as GoatBrainFolderRow[]).filter(
      isKnowledgeFolderView,
    );
  }, [documents, fileRows?.length, filesLoading, folderRows, foldersLoading, initialFolders]);
  const draftIngestStatesByBrainId = useMemo(
    () =>
      buildGoatBrainDraftIngestStates(
        (ingestJobRows ?? []) as GoatBrainIngestJobRow[],
        (captureSourceItemRows ?? []) as GoatBrainSourceItemRow[],
      ),
    [captureSourceItemRows, ingestJobRows],
  );
  const brainDataLoading = !initialDataLoaded && filesLoading && !fileRows?.length;

  return (
    <GoatBrainEditor
      brainRef={brainRef}
      brain={brain}
      folders={folders}
      documents={documents}
      edgeRows={(edgeRows ?? []) as GoatBrainEdgeRow[]}
      draftIngestStatesByBrainId={draftIngestStatesByBrainId}
      initialFolderPath={initialFolderPath}
      initialBrainId={initialBrainId}
      routeBrainId={routeBrainId ?? null}
      initialOverview={initialOverview}
      overviewStats={overviewStats}
      initialDataLoaded={initialDataLoaded}
      brainDataLoading={brainDataLoading}
    />
  );
}

function GoatBrainEditor({
  brainRef,
  brain,
  folders,
  documents: syncedDocuments,
  edgeRows = [],
  draftIngestStatesByBrainId = EMPTY_DRAFT_INGEST_STATES,
  initialFolderPath,
  initialBrainId,
  routeBrainId,
  initialOverview = false,
  overviewStats = null,
  brainDataLoading = false,
}: Props & {
  edgeRows?: GoatBrainEdgeRow[];
  draftIngestStatesByBrainId?: ReadonlyMap<string, GoatBrainDraftIngestState>;
  brainDataLoading?: boolean;
}) {
  const router = useRouter();
  const navInset = useGoatNavInset();
  const { workspace } = useGoatAppData();
  const canEditBrain = workspace.role === "admin";
  const [optimisticDocumentState, setOptimisticDocumentState] = useState<{
    syncedDocuments: GoatBrainDocumentView[];
    createdDocuments: GoatBrainDocumentView[];
  }>({ syncedDocuments, createdDocuments: [] });
  if (optimisticDocumentState.syncedDocuments !== syncedDocuments) {
    const syncedIds = new Set(syncedDocuments.map((document) => document.id));
    setOptimisticDocumentState({
      syncedDocuments,
      createdDocuments: optimisticDocumentState.createdDocuments.filter(
        (document) => !syncedIds.has(document.id),
      ),
    });
  }
  const optimisticCreatedDocuments = optimisticDocumentState.createdDocuments;
  const documents = useMemo(() => {
    if (optimisticCreatedDocuments.length === 0) return syncedDocuments;
    const syncedIds = new Set(syncedDocuments.map((document) => document.id));
    return [
      ...syncedDocuments,
      ...optimisticCreatedDocuments.filter((document) => !syncedIds.has(document.id)),
    ].toSorted(compareBrainDocuments);
  }, [optimisticCreatedDocuments, syncedDocuments]);
  const selectedBrainId = routeBrainId ?? null;
  const initialDocument = useMemo(
    () =>
      initialOverview ? null : resolveInitialDocument(documents, initialFolderPath, initialBrainId),
    [documents, initialBrainId, initialFolderPath, initialOverview],
  );
  const initialSelectedFolder = initialFolderPath ?? initialDocument?.folderPath ?? "inbox";
  const routeSelectionKey = `${brainRef ?? ""}:${initialFolderPath ?? ""}:${initialBrainId ?? ""}:${initialOverview ? "overview" : "browser"}`;
  const [selectionKey, setSelectionKey] = useState(routeSelectionKey);
  const [overviewSelected, setOverviewSelected] = useState(initialOverview);
  const [selectedFolder, setSelectedFolder] = useState(initialSelectedFolder);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(
    initialDocument?.id ?? null,
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(ancestorFolderPaths(initialDocument?.folderPath ?? initialSelectedFolder)),
  );
  const [query, setQuery] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [isDocPending, startDocTransition] = useTransition();
  const [isCreatePending, startCreateTransition] = useTransition();
  const [isFolderPending, startFolderTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<BrainContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [fileDialogFolder, setFileDialogFolder] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [docPanelState, setDocPanelState] = useState<{
    docId: string | null;
    value: string;
    description: string;
    model: string;
    detailsOpen: boolean;
    timelineOpen: boolean;
  }>({
    docId: initialDocument?.id ?? null,
    value: documentEditorBody(initialDocument),
    description: initialDocument?.description ?? "",
    model: documentWorkflowModel(initialDocument),
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
  }>({
    docId: initialDocument?.id ?? null,
    savedValue: null,
    savedHash: null,
    failedValue: null,
  });
  const autosaveFor = useCallback((docId: string | null) => {
    if (autosaveRef.current.docId !== docId) {
      autosaveRef.current = {
        docId,
        savedValue: null,
        savedHash: null,
        failedValue: null,
      };
    }
    return autosaveRef.current;
  }, []);
  if (selectionKey !== routeSelectionKey) {
    setSelectionKey(routeSelectionKey);
    setOverviewSelected(initialOverview);
    setSelectedFolder(initialSelectedFolder);
    setSelectedDocumentId(initialDocument?.id ?? null);
    setExpandedPaths(
      new Set(ancestorFolderPaths(initialDocument?.folderPath ?? initialSelectedFolder)),
    );
  }

  const selectedDocument = useMemo(() => {
    if (!selectedDocumentId) return null;
    return documents.find((document) => document.id === selectedDocumentId) ?? null;
  }, [documents, selectedDocumentId]);
  const selectedDraftIngestState = selectedDocument
    ? (draftIngestStatesByBrainId.get(selectedDocument.brainId) ?? null)
    : null;
  const selectedCreatorName = useWorkspaceMemberName(selectedDocument?.createdByWorkosId ?? null);
  if (docPanelState.docId !== (selectedDocument?.id ?? null)) {
    setDocPanelState({
      docId: selectedDocument?.id ?? null,
      value: documentEditorBody(selectedDocument),
      description: selectedDocument?.description ?? "",
      model: documentWorkflowModel(selectedDocument),
      detailsOpen: false,
      timelineOpen: false,
    });
  }
  const editorValue = docPanelState.value;
  const editorDescription = docPanelState.description;
  const editorModel = docPanelState.model;
  const selectedBody = documentEditorBody(selectedDocument);
  const isSelectedSkill = Boolean(
    selectedDocument && isSkillLikeBrainFolder(selectedDocument.folderPath),
  );
  const isSelectedWorkflow = Boolean(
    selectedDocument && isGoatBrainWorkflowFolder(selectedDocument.folderPath),
  );
  const dirty = Boolean(
    selectedDocument &&
      (editorValue !== selectedBody ||
        (isSelectedSkill && editorDescription !== (selectedDocument.description ?? "")) ||
        (isSelectedWorkflow && editorModel !== documentWorkflowModel(selectedDocument))),
  );
  const editorSnapshot = JSON.stringify([editorValue, editorDescription, editorModel]);
  const activeFolder = selectedDocument?.folderPath ?? selectedFolder;
  const activePath = overviewSelected
    ? ""
    : selectedDocument
      ? brainDocumentTreePath(selectedDocument)
      : activeFolder;
  const activeFolderView = folders.find((folder) => folder.path === activeFolder) ?? null;
  const activeFolderEditable = activeFolderView?.source === "custom";
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
  const archivedDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return documents
      .filter((document) => document.status === "archived")
      .filter(
        (document) =>
          !normalizedQuery ||
          brainDocumentTreePath(document).toLowerCase().includes(normalizedQuery) ||
          (document.title?.toLowerCase() ?? "").includes(normalizedQuery),
      )
      .toSorted((a, b) => (a.title ?? a.brainId).localeCompare(b.title ?? b.brainId));
  }, [documents, query]);
  const isSearching = Boolean(query.trim());
  const selectedDocumentFolderPath = selectedDocument?.folderPath ?? null;
  const visibleExpandedPaths = useMemo(() => {
    if (isSearching) return new Set(collectFolderPaths(tree));
    return selectedDocumentFolderPath
      ? withAncestorFolders(expandedPaths, selectedDocumentFolderPath, true)
      : expandedPaths;
  }, [expandedPaths, isSearching, selectedDocumentFolderPath, tree]);
  const selectedDocumentUrl = selectedDocument
    ? brainDocumentUrl(selectedDocument, selectedBrainId)
    : null;

  useEffect(() => {
    if (!selectedDocument || !selectedDocumentUrl) return;
    if (
      window.location.pathname !== selectedDocumentUrl &&
      currentUrlTargetsDocument(selectedDocument.brainId, selectedBrainId)
    ) {
      replaceCurrentUrl(selectedDocumentUrl);
    }
  }, [selectedBrainId, selectedDocument, selectedDocumentUrl]);

  useEffect(() => {
    if (!contextMenu) return;

    const closeContextMenu = () => setContextMenu(null);
    // In the App Router, React hydrates `document`, so its delegated event
    // handlers sit on the same node as this listener. `stopPropagation()` inside
    // the menu can't stop a sibling listener on the same node, so we must ignore
    // presses that land inside the menu ourselves — otherwise the menu closes on
    // pointerdown and a mouse click never reaches the item (keyboard still works).
    const handlePointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      closeContextMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", closeContextMenu, true);
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
    };
  }, [contextMenu]);

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    fileFolderPath: string,
    folderParentPath: string,
  ) => {
    if (!brainRef || !canEditBrain) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 188)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 76)),
      fileFolderPath,
      folderParentPath,
    });
  };

  const selectDocument = (document: GoatBrainDocumentView) => {
    if (canEditBrain) saveRef.current(); // flush pending edits on the outgoing document
    setOverviewSelected(false);
    setSelectedFolder(document.folderPath);
    setSelectedDocumentId(document.id);
    setExpandedPaths((current) => withAncestorFolders(current, document.folderPath));
    replaceCurrentUrl(brainDocumentUrl(document, selectedBrainId));
  };

  // Resolve an internal brain href (as produced by brainDocumentUrl/brainFolderUrl)
  // to a target in the current brain and select it via local state — same instant
  // path the sidebar uses. Returns false for anything not in this brain so the
  // caller can fall back to a full navigation.
  const navigateToBrainHref = (href: string): boolean => {
    const document = documents.find(
      (candidate) => brainDocumentUrl(candidate, selectedBrainId) === href,
    );
    if (document) {
      selectDocument(document);
      return true;
    }
    const folder = folders.find(
      (candidate) => brainFolderUrl(candidate.path, selectedBrainId) === href,
    );
    if (folder) {
      if (canEditBrain) saveRef.current();
      setOverviewSelected(false);
      setSelectedFolder(folder.path);
      setSelectedDocumentId(null);
      setExpandedPaths((current) => withAncestorFolders(current, folder.path));
      replaceCurrentUrl(brainFolderUrl(folder.path, selectedBrainId));
      return true;
    }
    return false;
  };

  const toggleFolder = (path: string) => {
    if (overviewSelected) replaceCurrentUrl(brainFolderUrl(path, selectedBrainId));
    setOverviewSelected(false);
    setSelectedFolder(path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Saves never reseed the editor draft: keystrokes made while a save is in flight
  // must survive, and the live collection brings the fresh body/contentHash after.
  const saveDocument = () => {
    // Binary-backed documents have no body editor; their compiled truth is
    // curated by the ingestion agent only.
    if (
      !brainRef ||
      !selectedDocument ||
      selectedDocument.format !== "markdown" ||
      !dirty ||
      isDocPending ||
      !canEditBrain
    )
      return;
    const autosave = autosaveFor(selectedDocument.id);
    if (editorSnapshot === autosave.savedValue) return;
    const documentId = selectedDocument.id;
    const body = editorValue;
    const expectedContentHash = autosave.savedHash ?? selectedDocument.contentHash;
    startDocTransition(async () => {
      const result = isGoatBrainSkillFolder(selectedDocument.folderPath)
        ? await updateGoatBrainSkillAction({
            brainRef,
            documentId,
            name: selectedDocument.title,
            description: editorDescription,
            instructions: body,
            expectedContentHash,
          })
        : isGoatBrainWorkflowFolder(selectedDocument.folderPath)
          ? await updateGoatBrainWorkflowAction({
              brainRef,
              documentId,
              name: selectedDocument.title,
              description: editorDescription,
              instructions: body,
              model: editorModel,
              expectedContentHash,
            })
          : await updateGoatBrainDocumentAction({
              brainRef,
              documentId,
              body,
              expectedContentHash,
            });
      if (autosaveRef.current.docId !== documentId) return;
      if (!result.ok) {
        autosaveRef.current.failedValue = editorSnapshot;
        toast.error(result.message);
        return;
      }
      autosaveRef.current.savedValue = editorSnapshot;
      autosaveRef.current.failedValue = null;
      if (result.document) autosaveRef.current.savedHash = result.document.contentHash;
    });
  };
  const saveRef = useRef(saveDocument);
  useEffect(() => {
    saveRef.current = saveDocument;
  });

  const selectOverview = () => {
    if (canEditBrain) saveRef.current();
    setOverviewSelected(true);
    setSelectedDocumentId(null);
    replaceCurrentUrl(brainOverviewUrl(selectedBrainId));
  };

  // Debounced autosave: fires once typing pauses; when an in-flight save finishes
  // (isDocPending flips), the effect re-arms so newer edits get their own save.
  useEffect(() => {
    if (!canEditBrain || !dirty || isDocPending) return;
    const autosave = autosaveFor(selectedDocumentId);
    if (editorSnapshot === autosave.savedValue || editorSnapshot === autosave.failedValue) return;
    const timer = setTimeout(() => saveRef.current(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autosaveFor, canEditBrain, dirty, editorSnapshot, isDocPending, selectedDocumentId]);

  // Rename deliberately does NOT reseed the editor draft (applyDocumentResult), so unsaved
  // body edits survive a title change; the live collection syncs title + contentHash after.
  const renameDocument = (title: string) => {
    if (!brainRef || !selectedDocument || !canEditBrain) return;
    const currentTitle = selectedDocument.title ?? selectedDocument.brainId;
    if (title === currentTitle) return;
    startDocTransition(async () => {
      const result = await renameGoatBrainDocumentAction({
        brainRef,
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
      const skillIsComplete =
        isSkillLikeBrainFolder(selectedDocument.folderPath) && Boolean(editorValue.trim());
      await navigator.clipboard.writeText(
        skillIsComplete
          ? serializeGoatBrainSkillMarkdown({
              id: selectedDocument.brainId,
              name: selectedDocument.title,
              description: editorDescription.trim(),
              instructions: editorValue.trim(),
            })
          : editorValue,
      );
      toast.success("Copied markdown");
    } catch {
      toast.error("Could not copy to clipboard.");
    }
  };

  const deleteDocument = () => {
    if (!brainRef || !selectedDocument || !canEditBrain) return;
    if (!confirm(`Delete "${selectedDocument.title ?? selectedDocument.brainId}"?`)) return;
    startDocTransition(async () => {
      const deletedId = selectedDocument.id;
      const result = await deleteGoatBrainDocumentAction({
        brainRef,
        documentId: deletedId,
      });
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
        replaceCurrentUrl(brainDocumentUrl(next, selectedBrainId));
      } else {
        replaceCurrentUrl(brainFolderUrl(activeFolder, selectedBrainId));
      }
    });
  };

  const submitFileDialog = (fileName: string) => {
    const folderPath = fileDialogFolder;
    if (!brainRef || !folderPath || !canEditBrain) return;
    const trimmed = fileName.trim();
    if (!trimmed) {
      toast.error("Give the Markdown file a name.");
      return;
    }
    startCreateTransition(async () => {
      const result = await createGoatBrainDocumentAction({
        brainRef,
        folderPath,
        fileName: trimmed,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setFileDialogFolder(null);
      setQuery("");
      const createdDocument = result.document;
      if (createdDocument) {
        setOptimisticDocumentState((current) => ({
          ...current,
          createdDocuments: [
            ...current.createdDocuments.filter((document) => document.id !== createdDocument.id),
            createdDocument,
          ],
        }));
        selectDocument(createdDocument);
      }
      toast.success("Markdown file created");
    });
  };

  const submitSkillDialog = (name: string, description: string) => {
    const folderPath = fileDialogFolder;
    if (!brainRef || !folderPath || !canEditBrain) return;
    const creatingWorkflow = isGoatBrainWorkflowFolder(folderPath);
    startCreateTransition(async () => {
      const result = creatingWorkflow
        ? await createGoatBrainWorkflowAction({
            brainRef,
            folderPath,
            name,
            description,
          })
        : await createGoatBrainSkillAction({
            brainRef,
            folderPath,
            name,
            description,
          });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setFileDialogFolder(null);
      setQuery("");
      const createdDocument = result.document;
      if (createdDocument) {
        setOptimisticDocumentState((current) => ({
          ...current,
          createdDocuments: [
            ...current.createdDocuments.filter((document) => document.id !== createdDocument.id),
            createdDocument,
          ],
        }));
        selectDocument(createdDocument);
      }
      toast.success(creatingWorkflow ? "Workflow created" : "Skill created");
    });
  };

  const submitFolderDialog = (folderPath: string) => {
    const dialog = folderDialog;
    if (!brainRef || !dialog || !canEditBrain) return;
    const trimmed = folderPath.trim();
    if (!trimmed) {
      toast.error("Give the folder a path.");
      return;
    }
    startFolderTransition(async () => {
      const result =
        dialog.kind === "create"
          ? await createGoatBrainFolderAction({ brainRef, folderPath: trimmed })
          : await renameGoatBrainFolderAction({
              brainRef,
              fromPath: dialog.path,
              toPath: trimmed,
            });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      const nextPath = result.path ?? trimmed;
      setFolderDialog(null);
      setOverviewSelected(false);
      setSelectedDocumentId(null);
      setSelectedFolder(nextPath);
      setExpandedPaths((current) => withAncestorFolders(current, nextPath, true));
      replaceCurrentUrl(brainFolderUrl(nextPath, selectedBrainId));
      toast.success(dialog.kind === "create" ? "Folder added" : "Folder renamed");
    });
  };

  const deleteFolder = (folderPath: string) => {
    if (!brainRef || !canEditBrain) return;
    if (!confirm(`Delete empty folder "${folderPath}"?`)) return;
    startFolderTransition(async () => {
      const result = await deleteGoatBrainFolderAction({
        brainRef,
        folderPath,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (activeFolder === folderPath || activeFolder.startsWith(`${folderPath}/`)) {
        setSelectedDocumentId(null);
        setSelectedFolder("inbox");
        replaceCurrentUrl(brainFolderUrl("inbox", selectedBrainId));
      }
      toast.success("Folder removed");
    });
  };

  const selectUploadedDocument = (document: GoatBrainDocumentView) => {
    setOverviewSelected(false);
    setSelectedFolder(document.folderPath);
    setSelectedDocumentId(document.id);
    setExpandedPaths((current) => withAncestorFolders(current, document.folderPath, true));
    replaceCurrentUrl(brainDocumentUrl(document, selectedBrainId));
  };

  const uploadAssetFile = async (file: File | undefined) => {
    if (!file || !brainRef || isUploading || !canEditBrain) return;
    if (isSkillLikeBrainFolder(activeFolder)) {
      toast.error(
        isGoatBrainWorkflowFolder(activeFolder)
          ? "Workflows are Markdown-only and cannot contain uploads."
          : "Skills are Markdown-only and cannot contain uploads.",
      );
      return;
    }
    const invalid = validateBrainAssetFile(file);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    setIsUploading(true);
    try {
      const uploaded = await uploadBrainAssetBlob(brainRef, file);
      const result = await uploadGoatBrainAssetAction({
        brainRef,
        folderPath: activeFolder,
        blobUrl: uploaded.blobUrl,
        originalFileName: file.name,
        mimeType: uploaded.mediaType,
        sizeBytes: file.size,
        contentSha256: uploaded.contentSha256,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (result.quotaPaused) {
        toast.warning("Uploaded, but ingestion is paused by your plan.", {
          action: {
            label: "View usage",
            onClick: () => router.push("/settings/workspace/usage"),
          },
        });
      } else {
        toast.success("Uploaded — filing into the brain");
      }
      if (result.document) selectUploadedDocument(result.document);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  };

  const replaceAssetFile = async (file: File | undefined) => {
    if (!file || !brainRef || !selectedDocument || isUploading || !canEditBrain) return;
    const invalid = validateBrainAssetFile(file);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    setIsUploading(true);
    try {
      const uploaded = await uploadBrainAssetBlob(brainRef, file);
      const result = await replaceGoatBrainAssetAction({
        brainRef,
        documentId: selectedDocument.id,
        folderPath: selectedDocument.folderPath,
        blobUrl: uploaded.blobUrl,
        originalFileName: file.name,
        mimeType: uploaded.mediaType,
        sizeBytes: file.size,
        contentSha256: uploaded.contentSha256,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (result.quotaPaused) {
        toast.warning("File replaced, but ingestion is paused by your plan.", {
          action: {
            label: "View usage",
            onClick: () => router.push("/settings/workspace/usage"),
          },
        });
      } else {
        toast.success("File replaced — re-filing into the brain");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Replace failed.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <main
      className="flex h-full min-h-0 w-full overflow-hidden bg-canvas text-ink"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (!canEditBrain) return;
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
            {brainRef ? <GoatBrainActivity brainRef={brainRef} /> : null}
            {workspace.role === "admin" && brain ? (
              <button
                type="button"
                aria-label={`Open settings for ${brain.name}`}
                title="Brain settings"
                onClick={() => router.push(`/brain/${encodeURIComponent(brain.id)}/settings`)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <Settings2 size={15} strokeWidth={1.8} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="px-2 pb-1 pt-1">
          <button
            type="button"
            aria-current={overviewSelected ? "page" : undefined}
            onClick={selectOverview}
            className={`flex h-7 w-full items-center gap-1.5 rounded-[5px] px-2 text-left text-[13px] leading-5 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              overviewSelected
                ? "bg-surface-active text-ink"
                : "text-ink-muted hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <LayoutDashboard size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
            <span>Overview</span>
          </button>
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

        <input
          ref={replaceInputRef}
          type="file"
          accept={BRAIN_ASSET_ACCEPT}
          className="hidden"
          onChange={(event) => {
            void replaceAssetFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <div
          role="tree"
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
          onContextMenu={(event) => openContextMenu(event, activeFolder || "inbox", "")}
          onDragOver={(event) => {
            if (!canEditBrain) return;
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            if (!canEditBrain) return;
            if (event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            void uploadAssetFile(event.dataTransfer.files[0]);
          }}
        >
          {hasRootNodes ? (
            <div>
              {rootGroups.map((group, groupIndex) =>
                group.length > 0 ? (
                  <div key={group.map((node) => node.path).join("|")}>
                    {groupIndex > firstNonEmptyGroupIndex(rootGroups) ? (
                      <div
                        data-testid="brain-root-divider"
                        className="my-2 h-px bg-border-subtle"
                      />
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
                        onContextMenu={openContextMenu}
                      />
                    ))}
                  </div>
                ) : null,
              )}
            </div>
          ) : (
            <div className="px-2 py-8 text-[12.5px] leading-5 text-ink-muted">
              {brainDataLoading
                ? "Loading brain…"
                : documents.length === 0
                  ? "No brain files yet."
                  : "No files match that search."}
            </div>
          )}
          {archivedDocuments.length > 0 ? (
            <div className="mt-2">
              <button
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
                className="group flex h-7 w-full items-center gap-1.5 rounded-[5px] pl-[6px] pr-2 text-left text-[13px] leading-5 text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                {archivedOpen ? (
                  <ChevronDown size={13} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
                ) : (
                  <ChevronRight size={13} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
                )}
                <History size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
                <span className="min-w-0 truncate">Archived ({archivedDocuments.length})</span>
              </button>
              {archivedOpen
                ? archivedDocuments.map((document) => (
                    <button
                      key={document.id}
                      type="button"
                      onClick={() => selectDocument(document)}
                      onContextMenu={(event) =>
                        openContextMenu(event, document.folderPath, document.folderPath)
                      }
                      className={`group flex h-7 w-full items-center gap-1.5 rounded-[5px] pl-[20px] pr-2 text-left text-[13px] leading-5 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                        document.id === selectedDocument?.id
                          ? "bg-surface-active text-ink"
                          : "text-ink-muted hover:bg-surface-hover hover:text-ink"
                      }`}
                    >
                      <span className="h-[13px] w-[13px] shrink-0" />
                      <FileText size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
                      <span className="min-w-0 truncate">{document.title ?? document.brainId}</span>
                    </button>
                  ))
                : null}
            </div>
          ) : null}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center border-b border-border-subtle">
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-5">
            {overviewSelected ? (
              <>
                <LayoutDashboard size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
                <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">
                  Overview
                </span>
              </>
            ) : selectedDocument ? (
              <>
                <FileText size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
                <span
                  title={brainDocumentTreePath(selectedDocument)}
                  className="min-w-0 truncate text-[12.5px] font-medium text-ink"
                >
                  {brainDocumentTreePath(selectedDocument)}
                </span>
                <span className="hidden shrink-0 text-[12px] text-ink-subtle md:inline">
                  {selectedCreatorName && documentShowsAttribution(selectedDocument)
                    ? `Added by ${selectedCreatorName} · `
                    : ""}
                  Updated {formatRelativeTime(selectedDocument.updatedAt)}
                </span>
              </>
            ) : activeFolderView ? (
              <>
                <FolderIcon path={activeFolderView.path} />
                <span
                  title={activeFolderView.path}
                  className="min-w-0 truncate text-[12.5px] font-medium text-ink"
                >
                  {activeFolderView.path}
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
                    setDocPanelState((state) => ({
                      ...state,
                      detailsOpen: !state.detailsOpen,
                    }))
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
                    {!isSelectedSkill ? (
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
                    ) : null}
                    {canEditBrain && !isSelectedSkill && selectedDocument.format !== "markdown" ? (
                      <button
                        type="button"
                        aria-label="Replace file"
                        disabled={isUploading}
                        onClick={() => {
                          setMenuOpen(false);
                          replaceInputRef.current?.click();
                        }}
                        className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12.5px] text-ink transition-colors duration-150 hover:bg-surface-hover disabled:opacity-45"
                      >
                        <FileUp size={14} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
                        Replace file
                      </button>
                    ) : null}
                    {canEditBrain ? (
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
                    ) : null}
                  </PopoverContent>
                </Popover>
              </>
            ) : activeFolderView ? (
              <>
                {canEditBrain && activeFolderEditable ? (
                  <>
                    <button
                      type="button"
                      aria-label="Rename folder"
                      title="Rename folder"
                      disabled={isFolderPending}
                      onClick={() =>
                        setFolderDialog({
                          kind: "rename",
                          path: activeFolderView.path,
                        })
                      }
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-45"
                    >
                      <Pencil size={14} strokeWidth={1.9} />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete folder"
                      title="Delete folder"
                      disabled={isFolderPending}
                      onClick={() => deleteFolder(activeFolderView.path)}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-danger focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:opacity-45"
                    >
                      <Trash2 size={14} strokeWidth={1.9} />
                    </button>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </header>

        {overviewSelected && brainRef && brain ? (
          <GoatBrainOverview
            brainName={brain.name}
            brainRef={brainRef}
            stats={overviewStats ?? EMPTY_OVERVIEW_STATS}
          />
        ) : !selectedDocument && documents.length === 0 && brainRef && canEditBrain ? (
          <section className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto bg-canvas px-6 py-10">
            <GoatBrainImport brainRef={brainRef} />
          </section>
        ) : (
          <BrainDocumentPanel
            key={selectedDocument?.id ?? "empty"}
            selectedDocument={selectedDocument}
            documents={documents}
            brainLinks={brainLinks}
            graphLinks={graphLinks}
            routeBrainId={selectedBrainId}
            editorValue={editorValue}
            editorDescription={editorDescription}
            editorModel={editorModel}
            detailsOpen={docPanelState.detailsOpen}
            timelineOpen={isSelectedSkill ? false : docPanelState.timelineOpen}
            isDocPending={isDocPending}
            readOnly={!canEditBrain}
            onEditorChange={(value) =>
              setDocPanelState((state) => (state.value === value ? state : { ...state, value }))
            }
            onDescriptionChange={(description) =>
              setDocPanelState((state) =>
                state.description === description ? state : { ...state, description },
              )
            }
            onModelChange={(model) =>
              setDocPanelState((state) => (state.model === model ? state : { ...state, model }))
            }
            onRenameTitle={renameDocument}
            onNavigateInternal={navigateToBrainHref}
          />
        )}
      </div>
      {contextMenu && canEditBrain ? (
        <BrainContextMenu
          ref={contextMenuRef}
          state={contextMenu}
          creating={brainFileKindForFolder(contextMenu.fileFolderPath)}
          onCreateFile={() => {
            setContextMenu(null);
            setFileDialogFolder(contextMenu.fileFolderPath);
          }}
          onCreateFolder={() => {
            setContextMenu(null);
            setFolderDialog({
              kind: "create",
              ...(contextMenu.folderParentPath
                ? { initialPath: `${contextMenu.folderParentPath}/` }
                : {}),
            });
          }}
        />
      ) : null}
      {fileDialogFolder && canEditBrain ? (
        isSkillLikeBrainFolder(fileDialogFolder) ? (
          <SkillDialog
            kind={isGoatBrainWorkflowFolder(fileDialogFolder) ? "workflow" : "skill"}
            pending={isCreatePending}
            onClose={() => setFileDialogFolder(null)}
            onSubmit={submitSkillDialog}
          />
        ) : (
          <FileDialog
            pending={isCreatePending}
            onClose={() => setFileDialogFolder(null)}
            onSubmit={submitFileDialog}
          />
        )
      ) : null}
      {folderDialog && canEditBrain ? (
        <FolderDialog
          state={folderDialog}
          pending={isFolderPending}
          onClose={() => setFolderDialog(null)}
          onSubmit={submitFolderDialog}
        />
      ) : null}
    </main>
  );
}

function BrainContextMenu({
  ref,
  state,
  creating,
  onCreateFile,
  onCreateFolder,
}: {
  ref?: Ref<HTMLDivElement>;
  state: BrainContextMenuState;
  creating: "skill" | "workflow" | "file";
  onCreateFile: () => void;
  onCreateFolder: () => void;
}) {
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Brain file actions"
      className="fixed z-[90] min-w-[180px] overflow-hidden rounded-md border border-border-strong bg-surface-raised py-1 text-[12.5px] text-ink shadow-[0_10px_30px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
      style={{ left: state.x, top: state.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        );
        const currentIndex = items.indexOf(document.activeElement as HTMLElement);
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = (currentIndex + direction + items.length) % items.length;
        items[nextIndex]?.focus();
      }}
    >
      <ContextMenuButton
        autoFocus
        icon={
          creating === "skill" ? (
            <Sparkles size={14} strokeWidth={1.8} />
          ) : creating === "workflow" ? (
            <WorkflowIcon size={14} strokeWidth={1.8} />
          ) : (
            <FilePlus2 size={14} strokeWidth={1.8} />
          )
        }
        label={
          creating === "skill"
            ? "New skill"
            : creating === "workflow"
              ? "New workflow"
              : "New Markdown file"
        }
        onClick={onCreateFile}
      />
      <ContextMenuButton
        icon={<FolderPlus size={14} strokeWidth={1.8} />}
        label="New folder"
        onClick={onCreateFolder}
      />
    </div>
  );
}

function SkillDialog({
  pending,
  onClose,
  onSubmit,
  kind = "skill",
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (name: string, description: string) => void;
  kind?: "skill" | "workflow";
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const isWorkflow = kind === "workflow";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={isWorkflow ? "New workflow" : "New skill"}
    >
      <div className="flex w-full max-w-[420px] flex-col gap-3 rounded-lg bg-canvas p-4 shadow-xl">
        <div className="text-[14px] font-semibold text-ink">
          {isWorkflow ? "New workflow" : "New skill"}
        </div>
        <label className="flex flex-col gap-1 text-[12px] text-ink-subtle">
          Name
          <input
            autoFocus
            value={name}
            maxLength={160}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            placeholder={isWorkflow ? "Weekly report" : "Coding work"}
            className="rounded-md border border-ink/10 bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink/25"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-subtle">
          Description (optional)
          <textarea
            value={description}
            maxLength={1000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            placeholder={
              isWorkflow
                ? "What this workflow does when it runs as a task"
                : "How this skill guides coding sessions"
            }
            className="resize-none rounded-md border border-ink/10 bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink/25"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink/70 transition-colors hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || !name.trim()}
            onClick={() => onSubmit(name, description)}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ContextMenuButton({
  autoFocus,
  icon,
  label,
  onClick,
}: {
  autoFocus?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      autoFocus={autoFocus}
      onClick={onClick}
      className="flex h-7 w-full items-center gap-2 px-2.5 text-left text-ink transition-colors hover:bg-surface-hover focus:bg-surface-hover focus:outline-none"
    >
      <span className="flex w-4 shrink-0 justify-center text-ink-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function FileDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (fileName: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="New Markdown file"
    >
      <div className="flex w-full max-w-[360px] flex-col gap-3 rounded-lg bg-canvas p-4 shadow-xl">
        <div className="text-[14px] font-semibold text-ink">New Markdown file</div>
        <label className="flex flex-col gap-1 text-[12px] text-ink-subtle">
          File name
          <input
            autoFocus
            value={value}
            maxLength={163}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit(value);
              if (event.key === "Escape") onClose();
            }}
            placeholder="Untitled.md"
            className="rounded-md border border-ink/10 bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink/25"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink/70 transition-colors hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onSubmit(value)}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {pending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderDialog({
  state,
  pending,
  onClose,
  onSubmit,
}: {
  state: FolderDialogState;
  pending: boolean;
  onClose: () => void;
  onSubmit: (folderPath: string) => void;
}) {
  const [value, setValue] = useState(
    state.kind === "rename" ? state.path : (state.initialPath ?? ""),
  );
  const title = state.kind === "rename" ? "Rename folder" : "New folder";
  const action = state.kind === "rename" ? "Rename" : "Create";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="flex w-full max-w-[360px] flex-col gap-3 rounded-lg bg-canvas p-4 shadow-xl">
        <div className="text-[14px] font-semibold text-ink">{title}</div>
        <label className="flex flex-col gap-1 text-[12px] text-ink-subtle">
          Path
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit(value);
              if (event.key === "Escape") onClose();
            }}
            placeholder="projects"
            className="rounded-md border border-ink/10 bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink/25"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink/70 transition-colors hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onSubmit(value)}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {pending ? "Saving…" : action}
          </button>
        </div>
      </div>
    </div>
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
  onContextMenu,
}: {
  node: BrainTreeNode;
  depth: number;
  activePath: string;
  expandedPaths: Set<string>;
  draftIngestStatesByBrainId: ReadonlyMap<string, GoatBrainDraftIngestState>;
  onSelect: (document: GoatBrainDocumentView) => void;
  onToggleFolder: (path: string) => void;
  onContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    fileFolderPath: string,
    folderParentPath: string,
  ) => void;
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
        onContextMenu={(event) => {
          const folderPath = node.type === "folder" ? node.path : node.document?.folderPath;
          if (folderPath) onContextMenu(event, folderPath, folderPath);
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
              onContextMenu={onContextMenu}
            />
          ))
        : null}
    </div>
  );
}

function TreeIngestStatusSlot({ state }: { state: GoatBrainDraftIngestState | null }) {
  if (!state) return null;

  return (
    <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
      <BrainIngestStatusIcon state={state} compact />
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
  editorDescription,
  editorModel,
  detailsOpen,
  timelineOpen,
  isDocPending,
  readOnly,
  onEditorChange,
  onDescriptionChange,
  onModelChange,
  onRenameTitle,
  onNavigateInternal,
}: {
  selectedDocument: GoatBrainDocumentView | null;
  documents: GoatBrainDocumentView[];
  brainLinks: Record<string, string>;
  graphLinks: BrainGraphLink[];
  routeBrainId: string | null;
  editorValue: string;
  editorDescription: string;
  editorModel: string;
  detailsOpen: boolean;
  timelineOpen: boolean;
  isDocPending: boolean;
  readOnly: boolean;
  onEditorChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onRenameTitle: (title: string) => void;
  onNavigateInternal: (href: string) => boolean;
}) {
  if (!selectedDocument) {
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-muted">
          {readOnly
            ? "Select a brain file to view it."
            : "Create or select a brain file to edit it."}
        </div>
      </section>
    );
  }

  const isSkill = isSkillLikeBrainFolder(selectedDocument.folderPath);
  const isWorkflow = isGoatBrainWorkflowFolder(selectedDocument.folderPath);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      {timelineOpen ? <BrainDocumentTimeline document={selectedDocument} /> : null}

      <div className="flex min-h-0 flex-1">
        {selectedDocument.format !== "markdown" ? (
          <BrainAssetViewer
            document={selectedDocument}
            disabled={isDocPending || readOnly}
            onRenameTitle={onRenameTitle}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[760px] px-8 pb-24 pt-12">
              <BrainTitleEditor
                document={selectedDocument}
                disabled={isDocPending || readOnly}
                onRename={onRenameTitle}
              />
              {isSkill ? (
                <label className="mt-6 flex flex-col gap-2 text-[12px] font-medium text-ink-muted">
                  Description (optional)
                  <textarea
                    value={editorDescription}
                    maxLength={1000}
                    rows={3}
                    readOnly={readOnly}
                    disabled={isDocPending}
                    onChange={(event) => onDescriptionChange(event.target.value)}
                    placeholder={
                      isWorkflow
                        ? "Describe what this workflow does when it runs"
                        : "Describe when this skill should be used"
                    }
                    className="resize-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] font-normal leading-5 text-ink outline-none transition-colors focus:border-border-strong disabled:opacity-60"
                  />
                </label>
              ) : null}
              {isWorkflow ? (
                <label className="mt-4 flex flex-col gap-2 text-[12px] font-medium text-ink-muted">
                  Model
                  <select
                    value={editorModel}
                    disabled={isDocPending || readOnly}
                    onChange={(event) => onModelChange(event.target.value)}
                    className="w-fit min-w-[260px] rounded-md border border-border bg-surface px-3 py-2 text-[13px] font-normal leading-5 text-ink outline-none transition-colors focus:border-border-strong disabled:opacity-60"
                  >
                    <option value="">Default ({DEFAULT_WORKFLOW_MODEL_LABEL})</option>
                    {GOAT_WORKFLOW_MODEL_OPTIONS.map((option) => (
                      <option key={option.token} value={option.token}>
                        {option.label} — {option.hint}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="mt-6">
                {isSkill ? (
                  <div className="mb-2 text-[12px] font-medium text-ink-muted">Instructions</div>
                ) : null}
                <MarkdownGoatBrainEditor
                  content={editorValue}
                  onChange={onEditorChange}
                  brainLinks={brainLinks}
                  readOnly={readOnly}
                  onNavigateInternal={onNavigateInternal}
                />
              </div>
            </div>
          </div>
        )}

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

// Binary-backed documents render the file itself first-class (the browser's
// native PDF viewer); the brain metadata and the agent's summary live in the
// details sidebar around it, not in front of it.
function BrainAssetViewer({
  document,
  disabled,
  onRenameTitle,
}: {
  document: GoatBrainDocumentView;
  disabled: boolean;
  onRenameTitle: (title: string) => void;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border-subtle px-8 pb-4 pt-6">
        <BrainTitleEditor document={document} disabled={disabled} onRename={onRenameTitle} />
        <p className="mt-1 flex items-center gap-2 text-[12px] text-ink-subtle">
          <span className="truncate">{document.originalFileName ?? document.brainId}</span>
          {document.assetSizeBytes ? (
            <span className="shrink-0">{formatFileSize(document.assetSizeBytes)}</span>
          ) : null}
          <a
            href={`/api/brain-assets/${encodeURIComponent(document.id)}`}
            download={document.originalFileName ?? undefined}
            className="shrink-0 text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          >
            Download
          </a>
        </p>
      </div>
      {document.format === "pdf" ? (
        <iframe
          title={document.title ?? document.brainId}
          src={`/api/brain-assets/${encodeURIComponent(document.id)}`}
          className="min-h-0 w-full flex-1 border-0 bg-surface-muted"
        />
      ) : document.format === "image" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-muted p-6">
          {/* eslint-disable-next-line @next/next/no-img-element -- auth-scoped byte route; next/image can't optimize it. */}
          <img
            src={`/api/brain-assets/${encodeURIComponent(document.id)}`}
            alt={document.title ?? document.brainId}
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-muted">
          No inline preview for this file type yet — use Download.
        </div>
      )}
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Resolves a workos user id to a display name via the workspace member
// directory; null when unknown (user left, or no human originated the doc).
function useWorkspaceMemberName(workosUserId: string | null): string | null {
  const { workspaceMembers } = useGoatAppData();
  return useMemo(() => {
    if (!workosUserId) return null;
    const member = workspaceMembers.find((item) => item.workosUserId === workosUserId);
    if (!member) return null;
    const name = [member.firstName, member.lastName].filter(Boolean).join(" ");
    return name || member.email;
  }, [workosUserId, workspaceMembers]);
}

// Header attribution appears only where a single originator is meaningful —
// inbox captures, evidence records, and uploaded files. Compiled pages
// accumulate many people's contributions, so a single "added by" would
// overstate ownership there (the Properties panel still shows Created by).
function documentShowsAttribution(document: GoatBrainDocumentView) {
  return (
    document.kind === "evidence" ||
    document.folderPath === "inbox" ||
    document.folderPath.startsWith("inbox/") ||
    document.format !== "markdown"
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
  const createdByName = useWorkspaceMemberName(document.createdByWorkosId ?? null);
  const outgoingLinks = useMemo(
    () =>
      resolveGraphLinks(
        graphLinks.filter((link) => link.from === document.brainId),
        documentsByBrainId,
        "out",
      ),
    [document.brainId, documentsByBrainId, graphLinks],
  );
  const backlinks = useMemo(
    () =>
      resolveGraphLinks(
        graphLinks.filter((link) => link.to === document.brainId),
        documentsByBrainId,
        "in",
      ),
    [document.brainId, documentsByBrainId, graphLinks],
  );
  const pageOutgoingLinks = outgoingLinks.filter((link) => link.peer.kind === "page");
  const pageBacklinks = backlinks.filter((link) => link.peer.kind === "page");
  const evidenceItems =
    document.kind === "evidence"
      ? []
      : evidenceGraphItems(
          [...outgoingLinks, ...backlinks].filter((link) => link.peer.kind === "evidence"),
        );

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
          <MetadataRow label="Status" value={document.status} />
          {document.kind === "evidence" ? <MetadataRow label="Kind" value="evidence" /> : null}
          <MetadataRow label="Created" value={formatDateTime(document.createdAt)} />
          {createdByName ? <MetadataRow label="Created by" value={createdByName} /> : null}
          <MetadataRow label="Updated" value={formatDateTime(document.updatedAt)} />
          <span className="text-ink-subtle">ID</span>
          <code
            title={document.brainId}
            className="min-w-0 truncate rounded-sm bg-surface-muted px-1 py-0.5 text-[11px] text-ink-muted"
          >
            {document.brainId}
          </code>
          <MetadataRow label="Aliases" value={document.aliases.join(", ") || "-"} />
          <MetadataSourcesRow sources={document.sources} />
          {document.format !== "markdown" ? (
            <>
              <MetadataRow label="File" value={document.originalFileName ?? "-"} />
              <MetadataRow
                label="Size"
                value={document.assetSizeBytes ? formatFileSize(document.assetSizeBytes) : "-"}
              />
            </>
          ) : null}
        </div>
      </section>

      {document.format !== "markdown" ? (
        <section className="min-w-0">
          <h2 className="mb-1 text-[12px] font-semibold text-ink">Summary</h2>
          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap pr-1 text-[12px] leading-5 text-ink-muted">
            {document.body.trim() || "No summary yet — ingestion pending."}
          </p>
        </section>
      ) : null}

      {!isSkillLikeBrainFolder(document.folderPath) ? (
        <SidebarTimelineSection document={document} />
      ) : null}

      <GraphLinksList
        title="Outgoing"
        links={pageOutgoingLinks}
        empty="No outgoing links."
        routeBrainId={routeBrainId}
      />
      <GraphLinksList
        title="Backlinks"
        links={pageBacklinks}
        empty="No backlinks."
        routeBrainId={routeBrainId}
      />
      <EvidenceLinksList items={evidenceItems} routeBrainId={routeBrainId} />
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

function MetadataSourcesRow({ sources }: { sources: GoatBrainDocumentView["sources"] }) {
  return (
    <>
      <span className="text-ink-subtle">Sources</span>
      {sources.length > 0 ? (
        <span className="flex min-w-0 flex-col gap-1">
          {sources.map((source, index) => {
            const href = sourceHrefForRef(source.ref);
            const label = source.title || source.ref;
            const title = source.title ? `${source.title} (${source.ref})` : source.ref;
            if (!href) {
              return (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: duplicate source refs are valid.
                  key={`${source.ref}:${index}`}
                  title={title}
                  className="min-w-0 truncate text-ink"
                >
                  {label}
                </span>
              );
            }
            return (
              <a
                // biome-ignore lint/suspicious/noArrayIndexKey: duplicate source refs are valid.
                key={`${source.ref}:${index}`}
                href={href}
                title={title}
                target={isExternalHref(href) ? "_blank" : undefined}
                rel={isExternalHref(href) ? "noreferrer noopener" : undefined}
                className="min-w-0 truncate text-ink underline-offset-2 hover:underline"
              >
                {label}
              </a>
            );
          })}
        </span>
      ) : (
        <span className="min-w-0 truncate text-ink">-</span>
      )}
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
  empty,
  routeBrainId,
}: {
  title: string;
  links: ResolvedBrainGraphLink[];
  empty: string;
  routeBrainId: string | null | undefined;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold text-ink">{title}</h2>
        <span className="text-[12px] text-ink-subtle">{links.length}</span>
      </div>
      {links.length > 0 ? (
        <ol className="max-h-32 space-y-1 overflow-y-auto pr-1 text-[12px] leading-5">
          {links.map((link) => {
            return (
              <li
                key={`${link.sourceKind}:${link.type}:${link.from}:${link.to}`}
                className="min-w-0"
              >
                <Link
                  href={brainDocumentUrl(link.peer, routeBrainId)}
                  className="flex min-w-0 items-center gap-1.5 rounded-sm text-ink-muted hover:text-ink"
                >
                  <span className="truncate">{link.peer.title || link.peer.brainId}</span>
                  <span className="shrink-0 text-ink-subtle">
                    {link.direction === "out" ? "->" : "<-"} {link.type}
                  </span>
                </Link>
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

function resolveGraphLinks(
  links: BrainGraphLink[],
  documentsByBrainId: Map<string, GoatBrainDocumentView>,
  direction: "out" | "in",
): ResolvedBrainGraphLink[] {
  return links.flatMap((link) => {
    const peerId = direction === "out" ? link.to : link.from;
    const peer = documentsByBrainId.get(peerId);
    return peer ? [{ ...link, direction, peer, peerId }] : [];
  });
}

function evidenceGraphItems(links: ResolvedBrainGraphLink[]): EvidenceGraphItem[] {
  const byEvidenceId = new Map<string, EvidenceGraphItem>();
  for (const link of links) {
    const current = byEvidenceId.get(link.peerId);
    if (current) {
      if (!current.relationTypes.includes(link.type)) current.relationTypes.push(link.type);
      continue;
    }
    byEvidenceId.set(link.peerId, {
      peer: link.peer,
      relationTypes: [link.type],
    });
  }
  return [...byEvidenceId.values()].sort((a, b) =>
    (a.peer.title || a.peer.brainId).localeCompare(b.peer.title || b.peer.brainId),
  );
}

function EvidenceLinksList({
  items,
  routeBrainId,
}: {
  items: EvidenceGraphItem[];
  routeBrainId: string | null | undefined;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold text-ink">Evidence</h2>
        <span className="text-[12px] text-ink-subtle">{items.length}</span>
      </div>
      {items.length > 0 ? (
        <ol className="max-h-32 space-y-1 overflow-y-auto pr-1 text-[12px] leading-5">
          {items.map((item) => (
            <li key={item.peer.brainId} className="min-w-0">
              <Link
                href={brainDocumentUrl(item.peer, routeBrainId)}
                className="flex min-w-0 items-center gap-1.5 rounded-sm text-ink-muted hover:text-ink"
              >
                <span className="truncate">{item.peer.title || item.peer.brainId}</span>
                <span className="shrink-0 text-ink-subtle">{item.relationTypes.join(", ")}</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[12px] text-ink-subtle">No evidence links.</p>
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
        {entries.length > 0 ? (
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
  const groups: BrainTreeNode[][] = [[], [], []];
  for (const node of visibleNodes) {
    const root = node.path.split("/")[0] ?? node.path;
    groups[goatBrainRootFolderGroup(root)]?.push(node);
  }
  for (const group of groups) {
    group.sort(compareRootTreeNodes);
  }
  return groups;
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
  const root: BrainTreeNode = {
    name: "",
    path: "",
    type: "folder",
    children: [],
  };
  const normalizedQuery = query.trim().toLowerCase();
  // Merged docs are tombstones whose content lives in the page they were
  // merged into; hide them from the tree like the CLI's default list does.
  // Archived docs are retired and render in their own collapsed section.
  const listedDocuments = documents.filter(
    (document) => document.status !== "merged" && document.status !== "archived",
  );
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
    insertFolder(root, folder.path, folder);
  }
  for (const document of visibleDocuments) {
    insertDocument(root, document);
  }
  sortTreeNodes(root.children);
  return root;
}

function insertFolder(root: BrainTreeNode, path: string, folder?: GoatBrainFolderView) {
  const parts = path.split("/").filter(Boolean);
  let current = root;
  parts.forEach((part, index) => {
    const nextPath = parts.slice(0, index + 1).join("/");
    let child = current.children.find((item) => item.path === nextPath && item.type === "folder");
    if (!child) {
      child = { name: part, path: nextPath, type: "folder", children: [] };
      current.children.push(child);
    }
    if (folder && nextPath === folder.path) child.folder = folder;
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
      child = {
        name: part,
        path,
        type: isFile ? "file" : "folder",
        children: [],
      };
      current.children.push(child);
    }
    if (isFile) child.document = document;
    current = child;
  });
}

function sortTreeNodes(nodes: BrainTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    if (a.type === "folder" && b.type === "folder") {
      return compareGoatBrainFolderPaths(a.path, b.path);
    }
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) sortTreeNodes(node.children);
}

function compareRootTreeNodes(a: BrainTreeNode, b: BrainTreeNode) {
  if (a.type === "folder" && b.type === "folder") {
    return compareGoatBrainFolderPaths(a.path, b.path);
  }
  if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name);
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
    case "skills":
      return <Sparkles size={14} strokeWidth={1.8} className={className} />;
    case "workflows":
      return <WorkflowIcon size={14} strokeWidth={1.8} className={className} />;
    case "thoughts":
      return <Brain size={14} strokeWidth={1.8} className={className} />;
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
  if (isGoatBrainSkillFolder(path)) {
    return <Sparkles size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />;
  }
  if (isGoatBrainWorkflowFolder(path)) {
    return <WorkflowIcon size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />;
  }
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
    state.kind === "failed"
      ? CircleAlert
      : state.kind === "paused"
        ? CirclePause
        : state.kind === "retrying"
          ? RotateCw
          : Loader2;
  const label = draftIngestStateLabel(state);
  const colorClass =
    state.kind === "failed"
      ? "text-danger"
      : state.kind === "paused"
        ? "text-amber-600"
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
  if (state.kind === "paused") {
    return `Paused by plan${title}`;
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
  if (initialBrainId) {
    return (
      documents.find(
        (document) =>
          document.brainId === initialBrainId &&
          (!initialFolderPath || document.folderPath === initialFolderPath),
      ) ??
      documents.find((document) => document.brainId === initialBrainId) ??
      null
    );
  }
  return (
    documents.find((document) => document.folderPath === initialFolderPath) ?? documents[0] ?? null
  );
}

function brainDocumentUrl(document: GoatBrainDocumentView, routeBrainId?: string | null) {
  return brainPathUrl([...folderPathSegments(document.folderPath), document.brainId], routeBrainId);
}

function brainFolderUrl(folderPath: string, routeBrainId?: string | null) {
  return brainPathUrl(folderPathSegments(folderPath), routeBrainId);
}

function brainOverviewUrl(routeBrainId?: string | null) {
  return routeBrainId ? `/brain/${encodeURIComponent(routeBrainId)}` : "/brain";
}

function replaceCurrentUrl(href: string) {
  window.history.replaceState(window.history.state, "", href);
}

function currentUrlTargetsDocument(brainId: string, routeBrainId?: string | null) {
  const segments = window.location.pathname.split("/").filter(Boolean);
  if (segments[0] !== "brain") return false;
  const brainPathSegments = segments.slice(1);
  const pathSegments =
    routeBrainId && brainPathSegments[0] === encodeURIComponent(routeBrainId)
      ? brainPathSegments.slice(1)
      : brainPathSegments;
  if (pathSegments.length < 2) return false;
  return safeDecodePathSegment(pathSegments.at(-1) ?? "") === brainId;
}

function safeDecodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function brainDocumentTreePath(document: GoatBrainDocumentView) {
  // Recover the original uploaded extension where we have it; "image" and
  // generic "text" are formats, not useful tree extensions.
  const originalExtension = document.originalFileName?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const extension =
    document.format === "markdown"
      ? "md"
      : originalExtension
        ? originalExtension
        : document.format === "image"
          ? "png"
          : document.format;
  return `${document.folderPath}/${document.brainId}.${extension}`;
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
  for (const document of documents) {
    for (const source of document.sources ?? []) {
      addSourceLinkTarget(links, source.ref);
    }
    for (const target of sourceLinkTargets(documentInlineLinkText(document))) {
      addSourceLinkTarget(links, target);
    }
  }
  return links;
}

function addBrainLinkTarget(links: Record<string, string>, target: string, href: string) {
  links[target] = href;
  links[`page:${target}`] = href;
}

function addSourceLinkTarget(links: Record<string, string>, ref: string) {
  const href = sourceHrefForRef(ref);
  if (href) links[`source:${ref}`] = href;
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
  if (!document) return "";
  const body = normalizeGoatBrainCompiledTruth(document.body, document.title);
  return isSkillLikeBrainFolder(document.folderPath) &&
    body.trim() === GOAT_BRAIN_EMPTY_TRUTH_PLACEHOLDER
    ? ""
    : body;
}

// Skills and workflows share the structured name/description/instructions editing surface.
function isSkillLikeBrainFolder(path: string) {
  return isGoatBrainSkillFolder(path) || isGoatBrainWorkflowFolder(path);
}

// Workflows and skills were extracted out of the Brain into their own
// workspace-scoped surfaces (/workflows and /settings/skills). Hide their former
// reserved folders and documents from the Brain tree so the Brain stays purely
// knowledge/context. Existing rows are removed by the backfill + cleanup
// migration; this also hides them in the window before that runs.
function isKnowledgeDocument(document: { folderPath: string }): boolean {
  return !isSkillLikeBrainFolder(document.folderPath);
}

function isKnowledgeFolderView(folder: { path: string }): boolean {
  return !isSkillLikeBrainFolder(folder.path);
}

// The workflow's model choice lives in doc frontmatter (`model:`); "" = default.
function documentWorkflowModel(document: GoatBrainDocumentView | null | undefined) {
  if (!document || !isGoatBrainWorkflowFolder(document.folderPath)) return "";
  return parseGoatBrainDocument(document.content).frontmatter.model?.trim() ?? "";
}

function brainFileKindForFolder(path: string): "skill" | "workflow" | "file" {
  if (isGoatBrainSkillFolder(path)) return "skill";
  if (isGoatBrainWorkflowFolder(path)) return "workflow";
  return "file";
}

function ancestorFolderPaths(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function withAncestorFolders(current: Set<string>, folderPath: string, includeFolder = false) {
  const next = new Set(current);
  let changed = false;
  const ancestors = ancestorFolderPaths(folderPath);
  for (const path of includeFolder ? ancestors : ancestors.slice(0, -1)) {
    if (!next.has(path)) changed = true;
    next.add(path);
  }
  return changed ? next : current;
}

function documentViewFromRow(
  row: GoatBrainDocumentRow,
  timelineRows?: GoatBrainTimelineEntryRow[],
): GoatBrainDocumentView {
  const path = `${row.folder_path}/${row.brain_id}.md`;
  const title = row.title ?? row.brain_id;
  let description: string | undefined;
  try {
    description = parseGoatBrainDocument(row.content).frontmatter.description;
  } catch {}
  return {
    id: row.id,
    brainId: row.brain_id,
    folderPath: row.folder_path,
    path,
    title,
    ...(description ? { description } : {}),
    content: row.content,
    body: normalizeGoatBrainCompiledTruth(row.body, title),
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
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    parseError: null,
    createdByWorkosId: row.created_by_workos_id,
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

function deriveFolderViews(
  documents: GoatBrainDocumentView[],
  folderRows: GoatBrainFolderRow[] = [],
): GoatBrainFolderView[] {
  const byPath = new Map<string, GoatBrainFolderView>();
  const zero = new Date(0).toISOString();
  for (const folder of folderRows) {
    byPath.set(folder.path, {
      id: folder.id,
      path: folder.path,
      name: folderName(folder.path),
      source: folder.source,
      createdAt: folder.created_at,
      updatedAt: folder.updated_at,
    });
  }
  for (const document of documents) {
    for (const path of ancestorFolderPaths(document.folderPath)) {
      const existing = byPath.get(path);
      byPath.set(path, {
        id: existing?.id ?? `folder:${path}`,
        path,
        name: folderName(path),
        source: existing?.source ?? goatBrainFolderSourceForPath(path),
        createdAt: existing?.createdAt ?? document.createdAt,
        updatedAt:
          existing && existing.updatedAt > document.updatedAt
            ? existing.updatedAt
            : document.updatedAt,
      });
    }
  }
  if (byPath.size === 0) {
    byPath.set("inbox", {
      id: "folder:inbox",
      path: "inbox",
      name: "Inbox",
      source: "system",
      createdAt: zero,
      updatedAt: zero,
    });
  }
  return [...byPath.values()].toSorted((a, b) => compareGoatBrainFolderPaths(a.path, b.path));
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
  if (
    value === "pdf" ||
    value === "docx" ||
    value === "xlsx" ||
    value === "srt" ||
    value === "csv" ||
    value === "tsv" ||
    value === "json" ||
    value === "text" ||
    value === "image"
  ) {
    return value;
  }
  return "markdown";
}

function normalizeDocumentKind(value: string): GoatBrainDocumentView["kind"] {
  return value === "evidence" ? "evidence" : "page";
}

function normalizeEntityType(value: string): GoatBrainDocumentView["type"] {
  if (
    value === "person" ||
    value === "company" ||
    value === "project" ||
    value === "meeting" ||
    value === "concept" ||
    value === "source" ||
    value === "analysis" ||
    value === "note"
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
