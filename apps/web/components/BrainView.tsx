"use client";

import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createBrainFile as createWorkspaceBrainFile,
  deleteBrainFile as deleteWorkspaceBrainFile,
  deleteBrainFolder as deleteWorkspaceBrainFolder,
  renameBrainFile as renameWorkspaceBrainFile,
  renameBrainFolder as renameWorkspaceBrainFolder,
  updateBrainFile as updateWorkspaceBrainFile,
} from "@/lib/brain/actions";
import {
  brainFileRenameSelectionEnd,
  fileNameFromPath,
  resolveBrainFileRenameName,
} from "@/lib/brain/file-names";
import { encodeBrainPath } from "@/lib/brain/paths";
import { formatBrainRelativeTime } from "@/lib/brain/relative-time";
import {
  ancestorFolderPaths,
  type BrainTreeNode,
  buildBrainTree,
  collectFolderPaths,
  type FlatBrainNode,
  flattenVisibleTree,
  parentFolderPath,
} from "@/lib/brain/tree";
import { MarkdownBrainEditor } from "./MarkdownBrainEditor";
import { useBrainTreeKeyboard } from "./use-brain-tree-keyboard";

type BrainFile = {
  path: string;
  content: string;
  sizeBytes: number;
  contentHash: string;
  githubCommitSha: string | null;
  githubSyncedAt: string | null;
  githubSyncStatus: string;
  githubSyncError: string | null;
  updatedAt: string;
};

type AutoSaveState = "idle" | "dirty" | "saving" | "error";
type BrainTreeTarget =
  | { type: "root"; path: "" }
  | { type: "folder"; path: string }
  | { type: "file"; path: string };
type ContextMenuState = {
  x: number;
  y: number;
  target: BrainTreeTarget;
} | null;
type BrainDragItem = { type: "file" | "folder"; path: string };
type BrainViewSnapshot = {
  files: BrainFile[];
  selectedPath: string;
  selectedContextPath: string;
  draftContent: string;
  expandedPaths: Set<string>;
};

const AUTO_SAVE_DELAY_MS = 800;
const BRAIN_TREE_DRAG_MIME = "application/x-opencompany-brain-tree-item";

type InitialBrainSelection = {
  selectedPath: string;
  contextPath: string;
  expandedPaths: Set<string>;
  draftContent: string;
};

// Resolves the file/folder the brain should open with based on the URL path
// (`<urlBasePath>/<initialPath>`). An exact file match opens that file; a folder prefix opens the
// first file inside it (with the folder expanded); anything else falls back to the first file.
function resolveInitialBrainSelection(
  serverFiles: BrainFile[],
  initialPath: string,
): InitialBrainSelection {
  const fallback = serverFiles[0];
  const fallbackSelection: InitialBrainSelection = {
    selectedPath: fallback?.path ?? "",
    contextPath: fallback ? parentFolderPath(fallback.path) : "",
    expandedPaths: new Set(fallback ? ancestorFolderPaths(fallback.path) : []),
    draftContent: fallback?.content ?? "",
  };
  const normalized = initialPath.replace(/^\/+|\/+$/g, "");
  if (!normalized) return fallbackSelection;

  const exact = serverFiles.find((file) => file.path === normalized);
  if (exact) {
    return {
      selectedPath: exact.path,
      contextPath: parentFolderPath(exact.path),
      expandedPaths: new Set(ancestorFolderPaths(exact.path)),
      draftContent: exact.content,
    };
  }

  const folderPrefix = `${normalized}/`;
  const underFolder = serverFiles.find((file) => file.path.startsWith(folderPrefix));
  if (underFolder) {
    return {
      selectedPath: underFolder.path,
      contextPath: normalized,
      expandedPaths: new Set(ancestorFolderPaths(underFolder.path)),
      draftContent: underFolder.content,
    };
  }

  return fallbackSelection;
}

// Builds the URL that reflects the currently open brain file/folder. `basePath` is the surface
// root (e.g. `/company/brain`) so only URL-addressable surfaces sync; segment encoding is shared
// with the route and the session chips via `encodeBrainPath`.
function brainUrlForPath(basePath: string, path: string): string {
  const encoded = encodeBrainPath(path);
  return encoded ? `${basePath}/${encoded}` : basePath;
}

// The Brain CRUD surface, injected so the same view serves both the workspace Brain (brainFiles,
// GitHub-synced) and the personal Brain (the personal agent's bundle personal-brain/ subtree,
// local-only). Defaults to the workspace actions so existing callers need no change.
export type BrainActionResult = { ok: true; path: string } | { ok: false; error: string };
export type BrainActions = {
  createFile: (path: string, content?: string) => Promise<BrainActionResult>;
  updateFile: (path: string, content: string) => Promise<BrainActionResult>;
  renameFile: (fromPath: string, toPath: string) => Promise<BrainActionResult>;
  renameFolder: (fromPath: string, toPath: string) => Promise<BrainActionResult>;
  deleteFile: (path: string) => Promise<BrainActionResult>;
  deleteFolder: (path: string) => Promise<BrainActionResult>;
};

const WORKSPACE_BRAIN_ACTIONS: BrainActions = {
  createFile: createWorkspaceBrainFile,
  updateFile: updateWorkspaceBrainFile,
  renameFile: renameWorkspaceBrainFile,
  renameFolder: renameWorkspaceBrainFolder,
  deleteFile: deleteWorkspaceBrainFile,
  deleteFolder: deleteWorkspaceBrainFolder,
};

export default function BrainView({
  files: serverFiles,
  initialPath = "",
  urlBasePath,
  actions = WORKSPACE_BRAIN_ACTIONS,
  title = "Project brain",
  emptyHint = "Create a Brain file to start adding long-lived context.",
  refreshOnAction = true,
}: {
  files: BrainFile[];
  initialPath?: string;
  // When set (e.g. "/company/brain"), the open file/folder is reflected in the URL bar so it can be
  // linked to and restored on reload. Leave undefined on surfaces that aren't URL-addressable, where
  // syncing would otherwise hijack their route.
  urlBasePath?: string;
  actions?: BrainActions;
  title?: string;
  emptyHint?: string;
  refreshOnAction?: boolean;
}) {
  const {
    createFile: createBrainFile,
    updateFile: updateBrainFile,
    renameFile: renameBrainFile,
    renameFolder: renameBrainFolder,
    deleteFile: deleteBrainFile,
    deleteFolder: deleteBrainFolder,
  } = actions;
  const router = useRouter();
  // Resolve the initial file/folder from the URL exactly once; later prop changes (e.g. a
  // background `router.refresh`) must not yank the user off whatever they have open.
  const initialSelectionRef = useRef<InitialBrainSelection | null>(null);
  if (initialSelectionRef.current === null) {
    initialSelectionRef.current = resolveInitialBrainSelection(serverFiles, initialPath);
  }
  const initialSelection = initialSelectionRef.current;
  const [isPending, startTransition] = useTransition();
  const [files, setFiles] = useState(serverFiles);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState(initialSelection.selectedPath);
  const [selectedContextPath, setSelectedContextPath] = useState(initialSelection.contextPath);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(initialSelection.expandedPaths),
  );
  const [focusedPath, setFocusedPath] = useState(initialSelection.selectedPath);
  const [treeHasFocus, setTreeHasFocus] = useState(false);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const [draftContent, setDraftContent] = useState(initialSelection.draftContent);
  const [renamingPath, setRenamingPath] = useState("");
  const [renamingName, setRenamingName] = useState("");
  const [renamingType, setRenamingType] = useState<"file" | "folder" | null>(null);
  const [draggingItem, setDraggingItem] = useState<BrainDragItem | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>("idle");
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const saveInFlightRef = useRef(false);
  const pendingSavesRef = useRef(
    new Map<string, { content: string; waiters: Array<(ok: boolean) => void> }>(),
  );
  const optimisticMutationCountRef = useRef(0);
  const deletedPathsRef = useRef(new Set<string>());
  const selectedPathRef = useRef(selectedPath);
  const pendingCreatesRef = useRef(new Map<string, Promise<string | null>>());
  // Serialises brain create() calls: a double-click on "new file"/"new folder"
  // would otherwise fire two creates that read the same `files` snapshot, derive
  // the same path, and collide on one pendingCreatesRef key — orphaning a pending
  // promise so a follow-up rename bypasses the await (reintroducing the PRO-62 race).
  const creatingRef = useRef(false);

  const selected = files.find((file) => file.path === selectedPath) ?? null;
  const tree = useMemo(() => buildBrainTree(files, query), [files, query]);
  const visibleExpandedPaths = useMemo(() => {
    if (query.trim()) return new Set(collectFolderPaths(tree));
    return expandedPaths;
  }, [expandedPaths, query, tree]);
  const flatNodes = useMemo<FlatBrainNode[]>(
    () => flattenVisibleTree(tree, visibleExpandedPaths),
    [tree, visibleExpandedPaths],
  );
  const dirty = selected ? draftContent !== selected.content : false;
  const markdownFile = selected ? isMarkdownPath(selected.path) : false;

  // Reflects the open file/folder in the URL bar so it can be linked to (and restored on
  // reload) like the agent editor. Uses history.replaceState rather than router.replace so a
  // plain selection doesn't trigger a server roundtrip — every brain file is already loaded.
  const syncBrainUrl = useCallback(
    (path: string) => {
      if (!urlBasePath) return;
      const next = brainUrlForPath(urlBasePath, path);
      // Compare against the live address bar, not a cached value: router.refresh() can reset the URL
      // to the base route behind our back, so a cached "already synced" guard would wrongly skip
      // re-applying the deep link. Brain paths are restricted to [A-Za-z0-9._/-], so the encoded form
      // matches window.location.pathname verbatim.
      if (window.location.pathname === next) return;
      window.history.replaceState(window.history.state, "", next);
    },
    [urlBasePath],
  );

  const refreshAfterAction = useCallback(() => {
    if (refreshOnAction) router.refresh();
  }, [refreshOnAction, router]);

  const updateSelectedPath = useCallback(
    (path: string) => {
      selectedPathRef.current = path;
      setSelectedPath(path);
      if (path) setFocusedPath(path);
      syncBrainUrl(path);
    },
    [syncBrainUrl],
  );

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  // Re-assert the open file's URL whenever fresh server data lands. router.refresh() — including the
  // 2.5s GitHub-sync poll below — re-runs the server component on Next's canonical route and resets
  // the address bar to the base, because our history.replaceState runs outside the router. Re-syncing
  // on each serverFiles update makes the deep link survive those refreshes, and on mount settles a
  // stale/deleted initial URL onto the actually-open file. No-op when the URL already matches.
  useEffect(() => {
    syncBrainUrl(selectedPathRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverFiles]);

  useEffect(() => {
    if (!focusedPath) return;
    const container = treeScrollRef.current;
    if (!container) return;
    const row = container.querySelector(`[data-brain-path="${CSS.escape(focusedPath)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [focusedPath]);

  useEffect(() => {
    if (optimisticMutationCountRef.current > 0) return;
    setFiles(serverFiles);
  }, [serverFiles]);

  useEffect(() => {
    if (
      !files.some(
        (file) => file.githubSyncStatus === "pending" || file.githubSyncStatus === "syncing",
      )
    ) {
      return;
    }
    const interval = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(interval);
  }, [files, router]);

  useEffect(() => {
    const currentPaths = new Set(serverFiles.map((file) => file.path));
    for (const path of deletedPathsRef.current) {
      if (!currentPaths.has(path)) deletedPathsRef.current.delete(path);
    }
  }, [serverFiles]);

  useEffect(() => {
    if (!contextMenu) return;

    function closeContextMenu() {
      setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeContextMenu();
    }

    document.addEventListener("pointerdown", closeContextMenu);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!fileMenuOpen) return;

    function closeFileMenu(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && fileMenuRef.current?.contains(target)) return;
      setFileMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setFileMenuOpen(false);
    }

    document.addEventListener("pointerdown", closeFileMenu);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeFileMenu);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [fileMenuOpen]);

  const expandAncestors = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorFolderPaths(path)) {
        next.add(ancestor);
      }
      return next;
    });
  }, []);

  function moveExpandedFolderPaths(fromPath: string, toPath: string) {
    setExpandedPaths((current) => {
      const next = new Set<string>();
      for (const path of current) {
        if (path === fromPath) {
          next.add(toPath);
        } else if (path.startsWith(`${fromPath}/`)) {
          next.add(`${toPath}/${path.slice(fromPath.length + 1)}`);
        } else {
          next.add(path);
        }
      }
      return next;
    });
  }

  const saveDraft = useCallback(
    async (initialPath: string, initialContent: string) => {
      if (deletedPathsRef.current.has(initialPath)) return false;

      if (saveInFlightRef.current) {
        return new Promise<boolean>((resolve) => {
          const pending = pendingSavesRef.current.get(initialPath);
          if (pending) {
            pending.content = initialContent;
            pending.waiters.push(resolve);
            return;
          }
          pendingSavesRef.current.set(initialPath, {
            content: initialContent,
            waiters: [resolve],
          });
        });
      }

      let nextSave: { path: string; content: string } | null = {
        path: initialPath,
        content: initialContent,
      };
      let allSaved = true;
      let waiters: Array<(ok: boolean) => void> = [];

      while (nextSave) {
        const { path, content } = nextSave;
        if (deletedPathsRef.current.has(path)) {
          waiters.forEach((resolve) => resolve(false));
          waiters = [];
          const pendingSave = pendingSavesRef.current.entries().next();
          if (pendingSave.done) {
            nextSave = null;
          } else {
            const [nextPath, pending] = pendingSave.value;
            pendingSavesRef.current.delete(nextPath);
            waiters = pending.waiters;
            nextSave = { path: nextPath, content: pending.content };
          }
          continue;
        }

        saveInFlightRef.current = true;
        setAutoSaveState("saving");
        setError(null);

        let updateResult: Awaited<ReturnType<typeof updateBrainFile>>;
        try {
          updateResult = await updateBrainFile(path, content);
        } catch (error) {
          updateResult = {
            ok: false,
            error: error instanceof Error ? error.message : "Save failed.",
          };
        }
        saveInFlightRef.current = false;

        const saved = updateResult.ok;
        waiters.forEach((resolve) => resolve(saved));
        waiters = [];

        if (!updateResult.ok) {
          allSaved = false;
          setAutoSaveState("error");
          setError(updateResult.error);
        } else {
          if (selectedPathRef.current === path) {
            // Route through updateSelectedPath so the URL stays in sync if the save normalized the
            // path, instead of mutating selection directly and stranding the address bar on the old
            // path.
            updateSelectedPath(updateResult.path);
            setSelectedContextPath(parentFolderPath(updateResult.path));
            expandAncestors(updateResult.path);
          }
          setAutoSaveState("idle");
          refreshAfterAction();
        }

        const pendingSave = pendingSavesRef.current.entries().next();
        if (pendingSave.done) {
          nextSave = null;
        } else {
          const [nextPath, pending] = pendingSave.value;
          pendingSavesRef.current.delete(nextPath);
          waiters = pending.waiters;
          nextSave = { path: nextPath, content: pending.content };
        }
      }

      return allSaved;
    },
    [expandAncestors, refreshAfterAction, updateBrainFile, updateSelectedPath],
  );

  useEffect(() => {
    if (!selected || !dirty) return;

    const path = selected.path;
    const content = draftContent;
    const timeout = setTimeout(() => {
      void saveDraft(path, content);
    }, AUTO_SAVE_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [dirty, draftContent, saveDraft, selected]);

  function updateDraftContent(content: string) {
    if (autoSaveState === "error") setAutoSaveState("idle");
    setDraftContent(content);
  }

  function beginOptimisticMutation() {
    optimisticMutationCountRef.current += 1;
  }

  function finishOptimisticMutation() {
    optimisticMutationCountRef.current = Math.max(0, optimisticMutationCountRef.current - 1);
  }

  function captureBrainViewSnapshot(): BrainViewSnapshot {
    return {
      files,
      selectedPath: selectedPathRef.current,
      selectedContextPath,
      draftContent,
      expandedPaths: new Set(expandedPaths),
    };
  }

  function restoreBrainViewSnapshot(snapshot: BrainViewSnapshot) {
    setFiles(snapshot.files);
    updateSelectedPath(snapshot.selectedPath);
    setSelectedContextPath(snapshot.selectedContextPath);
    setDraftContent(snapshot.draftContent);
    setExpandedPaths(snapshot.expandedPaths);
  }

  function handleBrainActionError(error: unknown, fallback: string) {
    setError(error instanceof Error ? error.message : fallback);
  }

  function selectFile(file: BrainFile) {
    setError(null);
    if (selected && dirty) {
      void saveDraft(selected.path, draftContent);
    }
    updateSelectedPath(file.path);
    setSelectedContextPath(parentFolderPath(file.path));
    setDraftContent(file.content);
    expandAncestors(file.path);
  }

  function toggleFolder(path: string) {
    setSelectedContextPath(path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function focusBrainNode(path: string) {
    setFocusedPath(path);
    treeScrollRef.current?.focus();
  }

  function expandFolderPath(path: string) {
    setSelectedContextPath(path);
    setExpandedPaths((current) => {
      if (current.has(path)) return current;
      const next = new Set(current);
      next.add(path);
      return next;
    });
  }

  function autoExpandFolderPath(path: string) {
    setExpandedPaths((current) => {
      if (current.has(path)) return current;
      const next = new Set(current);
      next.add(path);
      return next;
    });
  }

  function collapseFolderPath(path: string) {
    setSelectedContextPath(path);
    setExpandedPaths((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  }

  function openBrainPath(path: string) {
    const file = files.find((candidate) => candidate.path === path);
    if (file) selectFile(file);
  }

  function renameBrainPath(path: string) {
    const node = flatNodes.find((candidate) => candidate.path === path);
    if (!node) return;
    if (node.type === "folder") startRenameFolder(path);
    else {
      const file = files.find((candidate) => candidate.path === path);
      if (file) startRenameFile(file);
    }
  }

  function deleteBrainPath(path: string) {
    const node = flatNodes.find((candidate) => candidate.path === path);
    if (!node) return;
    const index = flatNodes.findIndex((candidate) => candidate.path === path);
    const nextFocus =
      flatNodes[index + 1]?.path ?? flatNodes[index - 1]?.path ?? parentFolderPath(path);
    if (node.type === "folder") removeFolder(path);
    else {
      const file = files.find((candidate) => candidate.path === path);
      if (file) removeFile(file);
    }
    setFocusedPath(nextFocus ?? "");
  }

  const handleTreeKeyDown = useBrainTreeKeyboard({
    nodes: flatNodes,
    focusedPath,
    expandedPaths: visibleExpandedPaths,
    onFocus: focusBrainNode,
    onExpand: expandFolderPath,
    onCollapse: collapseFolderPath,
    onOpen: openBrainPath,
    onToggle: toggleFolder,
    onRename: renameBrainPath,
    onDelete: deleteBrainPath,
  });

  function createFile(contextPath = selectedContextPath) {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setError(null);
    const path = uniqueNewBrainFilePath(files, contextPath);
    const content = `# ${titleFromPath(path)}\n`;
    const snapshot = captureBrainViewSnapshot();
    beginOptimisticMutation();
    setFiles((currentFiles) =>
      sortBrainFiles([...currentFiles, createOptimisticBrainFile(path, content)]),
    );
    updateSelectedPath(path);
    setSelectedContextPath(parentFolderPath(path));
    setDraftContent(content);
    expandAncestors(path);
    setRenamingPath(path);
    setRenamingName(fileNameFromPath(path));
    setRenamingType("file");
    const pendingCreate = createDeferred<string | null>();
    // Track the key the pending-create is registered under so we can re-key it
    // (and reliably delete it) if the server normalises the path.
    let pendingKey = path;
    pendingCreatesRef.current.set(pendingKey, pendingCreate.promise);
    startTransition(async () => {
      try {
        const result = await createBrainFile(path, content);
        if (!result.ok) {
          restoreBrainViewSnapshot(snapshot);
          cancelRenameFile();
          setError(result.error);
          pendingCreate.resolve(null);
          return;
        }
        if (result.path !== path) {
          setFiles((currentFiles) => optimisticRenameBrainFile(currentFiles, path, result.path));
          updateSelectedPath(result.path);
          setSelectedContextPath(parentFolderPath(result.path));
          expandAncestors(result.path);
          setRenamingPath((current) => (current === path ? result.path : current));
          setRenamingName(fileNameFromPath(result.path));
          // Re-key the pending-create to the server path so a concurrent
          // moveBrainFile (which now looks the node up by result.path) finds it.
          pendingCreatesRef.current.delete(pendingKey);
          pendingKey = result.path;
          pendingCreatesRef.current.set(pendingKey, pendingCreate.promise);
        }
        pendingCreate.resolve(result.path);
        refreshAfterAction();
      } catch (error) {
        restoreBrainViewSnapshot(snapshot);
        cancelRenameFile();
        handleBrainActionError(error, "Create failed.");
        pendingCreate.resolve(null);
      } finally {
        pendingCreatesRef.current.delete(pendingKey);
        finishOptimisticMutation();
        creatingRef.current = false;
      }
    });
  }

  function createFolder(contextPath = selectedContextPath) {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setError(null);
    const folderPath = uniqueNewBrainFolderPath(files, contextPath);
    const path = `${folderPath}/new-note.md`;
    const content = `# ${titleFromPath(path)}\n`;
    const snapshot = captureBrainViewSnapshot();
    beginOptimisticMutation();
    setFiles((currentFiles) =>
      sortBrainFiles([...currentFiles, createOptimisticBrainFile(path, content)]),
    );
    updateSelectedPath(path);
    setSelectedContextPath(folderPath);
    setDraftContent(content);
    expandAncestors(path);
    setRenamingPath(folderPath);
    setRenamingName(fileNameFromPath(folderPath));
    setRenamingType("folder");
    // Resolves to the server-assigned folder path, or null if the create
    // failed. A concurrent moveBrainFolder awaits this before renaming so the
    // folder actually exists on the server first.
    const pendingCreate = createDeferred<string | null>();
    let pendingKey = folderPath;
    pendingCreatesRef.current.set(pendingKey, pendingCreate.promise);
    startTransition(async () => {
      try {
        const result = await createBrainFile(path, content);
        if (!result.ok) {
          restoreBrainViewSnapshot(snapshot);
          cancelRenameFile();
          setError(result.error);
          pendingCreate.resolve(null);
          return;
        }
        const resolvedFolder = parentFolderPath(result.path);
        if (result.path !== path) {
          setFiles((currentFiles) => optimisticRenameBrainFile(currentFiles, path, result.path));
          updateSelectedPath(result.path);
          setSelectedContextPath(parentFolderPath(result.path));
          expandAncestors(result.path);
          setRenamingPath((current) => (current === folderPath ? resolvedFolder : current));
          setRenamingName(fileNameFromPath(resolvedFolder));
          // Re-key to the server folder path so a concurrent moveBrainFolder
          // (which looks the folder up by resolvedFolder) finds the pending create.
          if (resolvedFolder !== pendingKey) {
            pendingCreatesRef.current.delete(pendingKey);
            pendingKey = resolvedFolder;
            pendingCreatesRef.current.set(pendingKey, pendingCreate.promise);
          }
        }
        pendingCreate.resolve(resolvedFolder);
        refreshAfterAction();
      } catch (error) {
        restoreBrainViewSnapshot(snapshot);
        cancelRenameFile();
        handleBrainActionError(error, "Create failed.");
        pendingCreate.resolve(null);
      } finally {
        pendingCreatesRef.current.delete(pendingKey);
        finishOptimisticMutation();
        creatingRef.current = false;
      }
    });
  }

  function startRenameFile(file: BrainFile) {
    setError(null);
    setRenamingPath(file.path);
    setRenamingName(fileNameFromPath(file.path));
    setRenamingType("file");
  }

  function startRenameFolder(path: string) {
    setError(null);
    setRenamingPath(path);
    setRenamingName(fileNameFromPath(path));
    setRenamingType("folder");
  }

  function cancelRenameFile() {
    setRenamingPath("");
    setRenamingName("");
    setRenamingType(null);
  }

  function selectRootContext() {
    setError(null);
    cancelRenameFile();
    setSelectedContextPath("");
  }

  function moveBrainFile(file: BrainFile, nextPath: string) {
    if (nextPath === file.path) {
      cancelRenameFile();
      finishDragItem();
      return;
    }

    if (files.some((candidate) => candidate.path === nextPath && candidate.path !== file.path)) {
      setError(`A Brain file already exists at ${nextPath}.`);
      finishDragItem();
      return;
    }

    setError(null);
    finishDragItem();
    const nextDraftContent = selected?.path === file.path ? draftContent : file.content;
    const snapshot = captureBrainViewSnapshot();
    beginOptimisticMutation();
    cancelRenameFile();
    setFiles((currentFiles) =>
      optimisticRenameBrainFile(currentFiles, file.path, nextPath, nextDraftContent),
    );
    updateSelectedPath(nextPath);
    setSelectedContextPath(parentFolderPath(nextPath));
    setDraftContent(nextDraftContent);
    expandAncestors(nextPath);
    startTransition(async () => {
      try {
        if (selected?.path === file.path && dirty) {
          const saved = await saveDraft(file.path, draftContent);
          if (!saved) {
            restoreBrainViewSnapshot(snapshot);
            return;
          }
        }

        // If the file was just created and the server create is still in-flight,
        // wait for it to complete before renaming so the file actually exists.
        // Use the server-assigned path as the rename source in case the server
        // normalised the original path (e.g. due to a collision).
        let sourcePath = file.path;
        const pendingCreate = pendingCreatesRef.current.get(file.path);
        if (pendingCreate !== undefined) {
          const resolvedSourcePath = await pendingCreate;
          // null means create failed. createFile's own error handler already
          // restored the pre-create snapshot. Do NOT restore this move's
          // post-create snapshot here — it still contains the ghost file and
          // would resurrect it as a phantom row. Just bail; the create owns
          // the rollback.
          if (resolvedSourcePath === null) {
            return;
          }
          sourcePath = resolvedSourcePath;
        }

        const result = await renameBrainFile(sourcePath, nextPath);
        if (!result.ok) {
          restoreBrainViewSnapshot(snapshot);
          setError(result.error);
          return;
        }
        if (result.path !== nextPath) {
          setFiles((currentFiles) =>
            optimisticRenameBrainFile(currentFiles, nextPath, result.path, nextDraftContent),
          );
          updateSelectedPath(result.path);
          setSelectedContextPath(parentFolderPath(result.path));
          expandAncestors(result.path);
        }
        refreshAfterAction();
      } catch (error) {
        restoreBrainViewSnapshot(snapshot);
        handleBrainActionError(error, "Rename failed.");
      } finally {
        finishOptimisticMutation();
      }
    });
  }

  function moveBrainFolder(folderPath: string, nextPath: string) {
    if (nextPath === folderPath) {
      cancelRenameFile();
      finishDragItem();
      return;
    }

    if (nextPath.startsWith(`${folderPath}/`)) {
      setError("Folders cannot be moved inside themselves.");
      finishDragItem();
      return;
    }

    const movedFiles = files.filter((file) => file.path.startsWith(`${folderPath}/`));
    if (movedFiles.length === 0) {
      setError("Brain folder not found.");
      finishDragItem();
      return;
    }

    const movingPaths = new Set(movedFiles.map((file) => file.path));
    const existingPaths = new Set(files.map((file) => file.path));
    const collision = movedFiles.find((file) => {
      const nextFilePath = `${nextPath}/${file.path.slice(folderPath.length + 1)}`;
      return existingPaths.has(nextFilePath) && !movingPaths.has(nextFilePath);
    });
    if (collision) {
      const nextFilePath = `${nextPath}/${collision.path.slice(folderPath.length + 1)}`;
      setError(`A Brain file already exists at ${nextFilePath}.`);
      finishDragItem();
      return;
    }

    setError(null);
    finishDragItem();
    cancelRenameFile();
    const selectedNextPath =
      selected && selected.path.startsWith(`${folderPath}/`)
        ? `${nextPath}/${selected.path.slice(folderPath.length + 1)}`
        : selected?.path;
    const snapshot = captureBrainViewSnapshot();
    beginOptimisticMutation();
    setFiles((currentFiles) =>
      optimisticMoveBrainFolder(
        currentFiles,
        folderPath,
        nextPath,
        selected?.path,
        selected && dirty ? draftContent : undefined,
      ),
    );
    moveExpandedFolderPaths(folderPath, nextPath);
    if (selectedNextPath) {
      updateSelectedPath(selectedNextPath);
      setSelectedContextPath(parentFolderPath(selectedNextPath));
      expandAncestors(selectedNextPath);
    } else {
      setSelectedContextPath(parentFolderPath(nextPath));
      expandAncestors(nextPath);
    }
    startTransition(async () => {
      try {
        if (selected && selected.path.startsWith(`${folderPath}/`) && dirty) {
          const saved = await saveDraft(selected.path, draftContent);
          if (!saved) {
            restoreBrainViewSnapshot(snapshot);
            return;
          }
        }

        // If the folder was just created and the server create is still
        // in-flight, wait for it before renaming so the folder actually exists.
        // Use the server-assigned folder path as the rename source in case the
        // server normalised the original path (e.g. due to a collision).
        let sourceFolderPath = folderPath;
        const pendingCreate = pendingCreatesRef.current.get(folderPath);
        if (pendingCreate !== undefined) {
          const resolvedFolderPath = await pendingCreate;
          // null means create failed. createFolder's own error handler already
          // restored the pre-create snapshot. Do NOT restore this move's
          // post-create snapshot — it still contains the ghost folder and would
          // resurrect it. Just bail; the create owns the rollback.
          if (resolvedFolderPath === null) {
            return;
          }
          sourceFolderPath = resolvedFolderPath;
        }

        const result = await renameBrainFolder(sourceFolderPath, nextPath);
        if (!result.ok) {
          restoreBrainViewSnapshot(snapshot);
          setError(result.error);
          return;
        }

        if (result.path !== nextPath) {
          setFiles((currentFiles) =>
            optimisticMoveBrainFolder(currentFiles, nextPath, result.path),
          );
          moveExpandedFolderPaths(nextPath, result.path);
          const normalizedSelectedNextPath =
            selectedNextPath && selectedNextPath.startsWith(`${nextPath}/`)
              ? `${result.path}/${selectedNextPath.slice(nextPath.length + 1)}`
              : selectedNextPath;
          if (normalizedSelectedNextPath) {
            updateSelectedPath(normalizedSelectedNextPath);
            setSelectedContextPath(parentFolderPath(normalizedSelectedNextPath));
            expandAncestors(normalizedSelectedNextPath);
          } else {
            setSelectedContextPath(parentFolderPath(result.path));
            expandAncestors(result.path);
          }
        }
        refreshAfterAction();
      } catch (error) {
        restoreBrainViewSnapshot(snapshot);
        handleBrainActionError(error, "Move failed.");
      } finally {
        finishOptimisticMutation();
      }
    });
  }

  function commitRenameFile(file: BrainFile) {
    const currentName = fileNameFromPath(file.path);
    const nextName = resolveBrainFileRenameName(currentName, renamingName);
    if (!nextName || nextName === fileNameFromPath(file.path)) {
      cancelRenameFile();
      return;
    }

    if (nextName.includes("/")) {
      setError("File names cannot include folders. Rename the file name only.");
      return;
    }

    const parent = parentFolderPath(file.path);
    const nextPath = parent ? `${parent}/${nextName}` : nextName;
    moveBrainFile(file, nextPath);
  }

  function commitRenameFolder(path: string) {
    const nextName = renamingName.trim();
    if (!nextName || nextName === fileNameFromPath(path)) {
      cancelRenameFile();
      return;
    }

    if (nextName.includes("/") || nextName.includes(".")) {
      setError("Folder names cannot include slashes or file extensions.");
      return;
    }

    const parent = parentFolderPath(path);
    const nextPath = parent ? `${parent}/${nextName}` : nextName;
    moveBrainFolder(path, nextPath);
  }

  function moveFileToFolder(filePath: string, folderPath: string) {
    const file = files.find((candidate) => candidate.path === filePath);
    if (!file) return;

    const fileName = fileNameFromPath(file.path);
    const nextPath = folderPath ? `${folderPath}/${fileName}` : fileName;
    moveBrainFile(file, nextPath);
  }

  function moveFolderToFolder(folderPath: string, targetFolderPath: string) {
    const folderName = fileNameFromPath(folderPath);
    const nextPath = targetFolderPath ? `${targetFolderPath}/${folderName}` : folderName;
    moveBrainFolder(folderPath, nextPath);
  }

  function startDragItem(item: BrainDragItem) {
    setDraggingItem(item);
    setDropTargetPath(null);
  }

  function finishDragItem() {
    setDraggingItem(null);
    setDropTargetPath(null);
  }

  function removeFile(file = selected) {
    if (!file) return;
    setFileMenuOpen(false);
    setError(null);
    const snapshot = captureBrainViewSnapshot();
    beginOptimisticMutation();
    deletedPathsRef.current.add(file.path);
    pendingSavesRef.current.delete(file.path);
    setFiles((currentFiles) => currentFiles.filter((candidate) => candidate.path !== file.path));
    if (selected?.path === file.path) {
      updateSelectedPath("");
      setDraftContent("");
    }
    setSelectedContextPath(parentFolderPath(file.path));
    setAutoSaveState("idle");
    startTransition(async () => {
      try {
        const result = await deleteBrainFile(file.path);
        if (!result.ok) {
          restoreBrainViewSnapshot(snapshot);
          deletedPathsRef.current.delete(file.path);
          setError(result.error);
          return;
        }
        refreshAfterAction();
      } catch (error) {
        restoreBrainViewSnapshot(snapshot);
        deletedPathsRef.current.delete(file.path);
        handleBrainActionError(error, "Delete failed.");
      } finally {
        finishOptimisticMutation();
      }
    });
  }

  function removeFolder(path: string) {
    const deletedFiles = files.filter((file) => file.path.startsWith(`${path}/`));
    if (deletedFiles.length === 0) return;
    const shouldDelete =
      deletedFiles.length === 1 ||
      window.confirm(`Delete ${deletedFiles.length} Brain files in "${fileNameFromPath(path)}"?`);
    if (!shouldDelete) return;

    setError(null);
    const snapshot = captureBrainViewSnapshot();
    beginOptimisticMutation();
    for (const file of deletedFiles) {
      deletedPathsRef.current.add(file.path);
      pendingSavesRef.current.delete(file.path);
    }
    setFiles((currentFiles) => currentFiles.filter((file) => !file.path.startsWith(`${path}/`)));
    if (selected?.path.startsWith(`${path}/`)) {
      updateSelectedPath("");
      setDraftContent("");
    }
    setSelectedContextPath(parentFolderPath(path));
    setAutoSaveState("idle");
    startTransition(async () => {
      try {
        const result = await deleteBrainFolder(path);
        if (!result.ok) {
          restoreBrainViewSnapshot(snapshot);
          for (const file of deletedFiles) deletedPathsRef.current.delete(file.path);
          setError(result.error);
          return;
        }
        refreshAfterAction();
      } catch (error) {
        restoreBrainViewSnapshot(snapshot);
        for (const file of deletedFiles) deletedPathsRef.current.delete(file.path);
        handleBrainActionError(error, "Delete failed.");
      } finally {
        finishOptimisticMutation();
      }
    });
  }

  function openContextMenu(event: React.MouseEvent, target: BrainTreeTarget) {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  }

  return (
    <main className="flex h-full min-w-0 flex-1 overflow-hidden bg-canvas">
      <BrainSidebar
        title={title}
        files={files}
        tree={tree}
        query={query}
        selectedPath={selected?.path ?? ""}
        selectedContextPath={selectedContextPath}
        expandedPaths={visibleExpandedPaths}
        focusedPath={focusedPath}
        treeHasFocus={treeHasFocus}
        onFocusItem={focusBrainNode}
        onTreeKeyDown={handleTreeKeyDown}
        onTreeFocusChange={setTreeHasFocus}
        treeScrollRef={treeScrollRef}
        isSearching={Boolean(query.trim())}
        onCreateFile={createFile}
        onCreateFolder={createFolder}
        onQueryChange={setQuery}
        onSelectFile={selectFile}
        onSelectRoot={selectRootContext}
        renamingPath={renamingPath}
        renamingName={renamingName}
        renamingType={renamingType}
        draggingItem={draggingItem}
        dropTargetPath={dropTargetPath}
        onStartRename={startRenameFile}
        onStartRenameFolder={startRenameFolder}
        onRenameNameChange={setRenamingName}
        onCommitRename={commitRenameFile}
        onCommitRenameFolder={commitRenameFolder}
        onCancelRename={cancelRenameFile}
        onToggleFolder={toggleFolder}
        onDragStartItem={startDragItem}
        onDragEndItem={finishDragItem}
        onDropFileToFolder={moveFileToFolder}
        onDropFolderToFolder={moveFolderToFolder}
        onDropTargetChange={setDropTargetPath}
        onAutoExpandFolder={autoExpandFolderPath}
        onContextMenu={openContextMenu}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-canvas/85 px-5 backdrop-blur-md">
          {selected ? (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px]">
                <div className="flex min-w-0 items-center gap-1.5">
                  <FileIcon path={selected.path} />
                  <span title={selected.path} className="min-w-0 truncate font-medium text-ink">
                    {fileNameFromPath(selected.path)}
                  </span>
                </div>
                <BrainUpdatedAt updatedAt={selected.updatedAt} />
              </div>
              <BrainCopyButton
                className="ml-auto shrink-0"
                text={`${fileNameFromPath(selected.path)}\n\n${draftContent}`}
              />
              <div ref={fileMenuRef} className="relative shrink-0">
                <button
                  type="button"
                  aria-label="Open file actions"
                  aria-expanded={fileMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setFileMenuOpen((open) => !open)}
                  className={`flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                    fileMenuOpen ? "bg-surface-active text-ink" : ""
                  }`}
                >
                  <MoreHorizontal size={15} strokeWidth={1.75} />
                </button>
                {fileMenuOpen ? (
                  <BrainFileMenu
                    file={selected}
                    deleteDisabled={isPending}
                    onDelete={() => removeFile(selected)}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <span className="text-[12.5px] text-ink-muted">No file selected</span>
          )}
        </div>

        {selected ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-6">
              {error ? (
                <div className="mb-4 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-[12px] text-danger">
                  {error}
                </div>
              ) : null}
              {markdownFile ? (
                <MarkdownBrainEditor
                  key={selected.path}
                  content={draftContent}
                  onChange={updateDraftContent}
                />
              ) : (
                <RawBrainEditor content={draftContent} onChange={updateDraftContent} />
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-[13px] text-ink-muted">
            {emptyHint}
          </div>
        )}
      </section>
      {contextMenu ? (
        <BrainContextMenu
          state={contextMenu}
          files={files}
          onCreateFile={(path) => createFile(path)}
          onCreateFolder={(path) => createFolder(path)}
          onRenameFile={(file) => startRenameFile(file)}
          onRenameFolder={startRenameFolder}
          onDeleteFile={removeFile}
          onDeleteFolder={removeFolder}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </main>
  );
}

function BrainSidebar({
  title,
  files,
  tree,
  query,
  selectedPath,
  selectedContextPath,
  expandedPaths,
  focusedPath,
  treeHasFocus,
  onFocusItem,
  onTreeKeyDown,
  onTreeFocusChange,
  treeScrollRef,
  isSearching,
  onCreateFile,
  onCreateFolder,
  onQueryChange,
  onSelectFile,
  onSelectRoot,
  renamingPath,
  renamingName,
  renamingType,
  draggingItem,
  dropTargetPath,
  onStartRename,
  onStartRenameFolder,
  onRenameNameChange,
  onCommitRename,
  onCommitRenameFolder,
  onCancelRename,
  onToggleFolder,
  onDragStartItem,
  onDragEndItem,
  onDropFileToFolder,
  onDropFolderToFolder,
  onDropTargetChange,
  onAutoExpandFolder,
  onContextMenu,
}: {
  title: string;
  files: BrainFile[];
  tree: BrainTreeNode<BrainFile>;
  query: string;
  selectedPath: string;
  selectedContextPath: string;
  expandedPaths: Set<string>;
  focusedPath: string;
  treeHasFocus: boolean;
  onFocusItem: (path: string) => void;
  onTreeKeyDown: (event: React.KeyboardEvent) => void;
  onTreeFocusChange: (hasFocus: boolean) => void;
  treeScrollRef: React.RefObject<HTMLDivElement | null>;
  isSearching: boolean;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onQueryChange: (query: string) => void;
  onSelectFile: (file: BrainFile) => void;
  onSelectRoot: () => void;
  renamingPath: string;
  renamingName: string;
  renamingType: "file" | "folder" | null;
  onStartRename: (file: BrainFile) => void;
  onStartRenameFolder: (path: string) => void;
  onRenameNameChange: (name: string) => void;
  onCommitRename: (file: BrainFile) => void;
  onCommitRenameFolder: (path: string) => void;
  onCancelRename: () => void;
  onToggleFolder: (path: string) => void;
  draggingItem: BrainDragItem | null;
  dropTargetPath: string | null;
  onDragStartItem: (item: BrainDragItem) => void;
  onDragEndItem: () => void;
  onDropFileToFolder: (filePath: string, folderPath: string) => void;
  onDropFolderToFolder: (folderPath: string, folderPathTarget: string) => void;
  onDropTargetChange: (path: string | null) => void;
  onAutoExpandFolder: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, target: BrainTreeTarget) => void;
}) {
  const canDropOnRoot = canDropItemOnFolder(draggingItem, "");

  return (
    <aside className="flex h-full w-[292px] shrink-0 flex-col border-r border-border bg-surface-muted">
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.16)]">
            <FileText size={14} strokeWidth={1.9} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-ink">{title}</div>
            <div className="mt-0.5 text-[11.5px] text-ink-muted">{files.length} files</div>
          </div>
          <button
            type="button"
            aria-label="Create brain file"
            title="Create brain file"
            onClick={() => onCreateFile()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <FilePlus2 size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="Create brain folder"
            title="Create brain folder"
            onClick={() => onCreateFolder()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <FolderPlus size={15} strokeWidth={1.8} />
          </button>
        </div>
        <label className="mt-3 flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-ink-muted shadow-[0_1px_0_rgba(0,0,0,0.02)]">
          <Search size={13} strokeWidth={1.75} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search brain"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
          />
        </label>
      </div>

      <div
        ref={treeScrollRef}
        role="tree"
        tabIndex={0}
        aria-activedescendant={
          focusedPath && !renamingPath ? `brain-row-${focusedPath}` : undefined
        }
        onKeyDown={onTreeKeyDown}
        onFocus={() => onTreeFocusChange(true)}
        onBlur={() => onTreeFocusChange(false)}
        className={`flex-1 overflow-y-auto px-2 py-3 transition-colors duration-150 focus:outline-none ${
          dropTargetPath === "" ? "bg-surface-hover" : ""
        }`}
        onClick={(event) => {
          if (event.target === event.currentTarget) onSelectRoot();
        }}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget)
            onContextMenu(event, { type: "root", path: "" });
        }}
        onDragOver={(event) => {
          if (!canDropOnRoot || event.target !== event.currentTarget) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          onDropTargetChange("");
        }}
        onDrop={(event) => {
          if (!canDropOnRoot || event.target !== event.currentTarget) return;
          event.preventDefault();
          const item = draggedBrainItem(event);
          if (item?.type === "file") onDropFileToFolder(item.path, "");
          if (item?.type === "folder") onDropFolderToFolder(item.path, "");
        }}
      >
        {tree.children.length > 0 ? (
          <div className="space-y-px">
            {tree.children.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                selectedContextPath={selectedContextPath}
                expandedPaths={expandedPaths}
                focusedPath={focusedPath}
                treeHasFocus={treeHasFocus}
                onFocusItem={onFocusItem}
                isSearching={isSearching}
                renamingPath={renamingPath}
                renamingName={renamingName}
                renamingType={renamingType}
                draggingItem={draggingItem}
                dropTargetPath={dropTargetPath}
                onSelect={onSelectFile}
                onStartRename={onStartRename}
                onStartRenameFolder={onStartRenameFolder}
                onRenameNameChange={onRenameNameChange}
                onCommitRename={onCommitRename}
                onCommitRenameFolder={onCommitRenameFolder}
                onCancelRename={onCancelRename}
                onToggleFolder={onToggleFolder}
                onDragStartItem={onDragStartItem}
                onDragEndItem={onDragEndItem}
                onDropFileToFolder={onDropFileToFolder}
                onDropFolderToFolder={onDropFolderToFolder}
                onDropTargetChange={onDropTargetChange}
                onAutoExpandFolder={onAutoExpandFolder}
                onContextMenu={onContextMenu}
              />
            ))}
          </div>
        ) : (
          <div className="px-2 py-8 text-[12.5px] leading-5 text-ink-muted">
            {files.length === 0 ? "No brain files yet." : "No files match that search."}
          </div>
        )}
      </div>
    </aside>
  );
}

function TreeItem({
  node,
  depth,
  selectedPath,
  selectedContextPath,
  expandedPaths,
  focusedPath,
  treeHasFocus,
  onFocusItem,
  isSearching,
  renamingPath,
  renamingName,
  renamingType,
  draggingItem,
  dropTargetPath,
  onSelect,
  onStartRename,
  onStartRenameFolder,
  onRenameNameChange,
  onCommitRename,
  onCommitRenameFolder,
  onCancelRename,
  onToggleFolder,
  onDragStartItem,
  onDragEndItem,
  onDropFileToFolder,
  onDropFolderToFolder,
  onDropTargetChange,
  onAutoExpandFolder,
  onContextMenu,
}: {
  node: BrainTreeNode<BrainFile>;
  depth: number;
  selectedPath: string;
  selectedContextPath: string;
  expandedPaths: Set<string>;
  focusedPath: string;
  treeHasFocus: boolean;
  onFocusItem: (path: string) => void;
  isSearching: boolean;
  renamingPath: string;
  renamingName: string;
  renamingType: "file" | "folder" | null;
  draggingItem: BrainDragItem | null;
  dropTargetPath: string | null;
  onSelect: (file: BrainFile) => void;
  onStartRename: (file: BrainFile) => void;
  onStartRenameFolder: (path: string) => void;
  onRenameNameChange: (name: string) => void;
  onCommitRename: (file: BrainFile) => void;
  onCommitRenameFolder: (path: string) => void;
  onCancelRename: () => void;
  onToggleFolder: (path: string) => void;
  onDragStartItem: (item: BrainDragItem) => void;
  onDragEndItem: () => void;
  onDropFileToFolder: (filePath: string, folderPath: string) => void;
  onDropFolderToFolder: (folderPath: string, folderPathTarget: string) => void;
  onDropTargetChange: (path: string | null) => void;
  onAutoExpandFolder: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, target: BrainTreeTarget) => void;
}) {
  const active = node.type === "file" && node.path === selectedPath;
  const focused = node.path === focusedPath && treeHasFocus;
  const contextActive = node.type === "folder" && node.path === selectedContextPath;
  const expanded = node.type === "folder" && expandedPaths.has(node.path);
  const showChildren = isSearching || expanded;
  const isRenaming = node.path === renamingPath && Boolean(renamingType);
  const dropFolder = dropFolderForNode(node);
  const canDropHere = canDropItemOnFolder(draggingItem, dropFolder);
  const dropActive = canDropHere && dropTargetPath === node.path;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const skipBlurCommitRef = useRef(false);
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoExpand = () => {
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
  };

  const scheduleAutoExpand = (path: string) => {
    if (autoExpandTimerRef.current) return;
    autoExpandTimerRef.current = setTimeout(() => {
      autoExpandTimerRef.current = null;
      onAutoExpandFolder(path);
    }, 600);
  };

  useEffect(() => clearAutoExpand, []);

  useEffect(() => {
    if (!isRenaming) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(0, brainFileRenameSelectionEnd(input.value));
  }, [isRenaming]);

  const rowClassName = `group flex w-full items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[12.5px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
    dropActive
      ? "bg-surface-active text-ink ring-1 ring-border-strong"
      : active
        ? "bg-surface-active text-ink"
        : focused
          ? "bg-surface-subtle text-ink ring-1 ring-border-strong"
          : contextActive
            ? "bg-surface-hover text-ink"
            : "text-ink/85 hover:bg-surface-subtle hover:text-ink"
  }`;
  const paddingStyle = { paddingLeft: `${6 + depth * 14}px` };

  return (
    <div>
      {isRenaming ? (
        <div
          id={`brain-row-${node.path}`}
          data-brain-path={node.path}
          className={rowClassName}
          style={paddingStyle}
        >
          {node.type === "folder" ? (
            <ChevronDown size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
          ) : (
            <span className="h-[13px] w-[13px] shrink-0" />
          )}
          {node.type === "folder" ? (
            <Folder size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
          ) : (
            <FileIcon path={node.path} />
          )}
          <input
            ref={renameInputRef}
            value={renamingName}
            onChange={(event) => onRenameNameChange(event.target.value)}
            onBlur={() => {
              if (skipBlurCommitRef.current) {
                skipBlurCommitRef.current = false;
                return;
              }
              if (node.type === "folder") onCommitRenameFolder(node.path);
              else if (node.file) onCommitRename(node.file);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                if (node.type === "folder") onCommitRenameFolder(node.path);
                else if (node.file) onCommitRename(node.file);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                skipBlurCommitRef.current = true;
                onCancelRename();
              }
            }}
            onClick={(event) => event.stopPropagation()}
            className="h-[21px] min-w-0 flex-1 rounded-[3px] border border-border-strong bg-surface px-1.5 font-mono text-[12px] text-ink outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          draggable
          id={`brain-row-${node.path}`}
          data-brain-path={node.path}
          role="treeitem"
          tabIndex={-1}
          aria-selected={active}
          aria-expanded={node.type === "folder" ? expanded : undefined}
          onClick={() => {
            onFocusItem(node.path);
            if (node.type === "folder") onToggleFolder(node.path);
            else if (node.file) onSelect(node.file);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            if (node.type === "folder") onStartRenameFolder(node.path);
            else if (node.file) onStartRename(node.file);
          }}
          onContextMenu={(event) => {
            if (node.type === "folder") onContextMenu(event, { type: "folder", path: node.path });
            else if (node.file) onContextMenu(event, { type: "file", path: node.path });
          }}
          onDragStart={(event) => {
            const item: BrainDragItem = { type: node.type, path: node.path };
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(BRAIN_TREE_DRAG_MIME, JSON.stringify(item));
            event.dataTransfer.setData("text/plain", node.path);
            onDragStartItem(item);
          }}
          onDragEnd={() => {
            clearAutoExpand();
            onDragEndItem();
          }}
          onDragOver={(event) => {
            if (!canDropHere) {
              if (draggingItem) onDropTargetChange(null);
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            onDropTargetChange(node.path);
            if (node.type === "folder" && !expanded) scheduleAutoExpand(node.path);
            else clearAutoExpand();
          }}
          onDrop={(event) => {
            if (!canDropHere) return;
            event.preventDefault();
            event.stopPropagation();
            clearAutoExpand();
            const item = draggedBrainItem(event);
            if (item?.type === "file") onDropFileToFolder(item.path, dropFolder);
            if (item?.type === "folder") onDropFolderToFolder(item.path, dropFolder);
          }}
          onDragLeave={() => clearAutoExpand()}
          className={rowClassName}
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
          {node.type === "folder" ? (
            <Folder size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
          ) : (
            <FileIcon path={node.path} />
          )}
          <span className="min-w-0 truncate tracking-[-0.005em]">{node.name}</span>
        </button>
      )}
      {node.type === "folder" && showChildren
        ? node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              selectedContextPath={selectedContextPath}
              expandedPaths={expandedPaths}
              focusedPath={focusedPath}
              treeHasFocus={treeHasFocus}
              onFocusItem={onFocusItem}
              isSearching={isSearching}
              renamingPath={renamingPath}
              renamingName={renamingName}
              renamingType={renamingType}
              draggingItem={draggingItem}
              dropTargetPath={dropTargetPath}
              onSelect={onSelect}
              onStartRename={onStartRename}
              onStartRenameFolder={onStartRenameFolder}
              onRenameNameChange={onRenameNameChange}
              onCommitRename={onCommitRename}
              onCommitRenameFolder={onCommitRenameFolder}
              onCancelRename={onCancelRename}
              onToggleFolder={onToggleFolder}
              onDragStartItem={onDragStartItem}
              onDragEndItem={onDragEndItem}
              onDropFileToFolder={onDropFileToFolder}
              onDropFolderToFolder={onDropFolderToFolder}
              onDropTargetChange={onDropTargetChange}
              onAutoExpandFolder={onAutoExpandFolder}
              onContextMenu={onContextMenu}
            />
          ))
        : null}
    </div>
  );
}

function RawBrainEditor({
  content,
  onChange,
}: {
  content: string;
  onChange: (content: string) => void;
}) {
  return (
    <textarea
      value={content}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      className="min-h-[560px] w-full resize-y rounded-md border border-border bg-surface px-4 py-3 font-mono text-[12.5px] leading-6 text-ink outline-none focus:border-border-strong"
    />
  );
}

function BrainCopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be blocked in insecure contexts
    }
  };

  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy title and contents"}
      title={copied ? "Copied" : "Copy title and contents"}
      onClick={handleCopy}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        copied ? "text-success" : ""
      } ${className ?? ""}`}
    >
      {copied ? <Check size={15} strokeWidth={1.75} /> : <Copy size={15} strokeWidth={1.75} />}
    </button>
  );
}

function BrainFileMenu({
  file,
  deleteDisabled,
  onDelete,
}: {
  file: BrainFile;
  deleteDisabled: boolean;
  onDelete: () => void;
}) {
  const shortSha = file.githubCommitSha ? file.githubCommitSha.slice(0, 7) : null;

  return (
    <div
      role="menu"
      className="absolute right-0 top-full z-[200] mt-1 w-[244px] overflow-hidden rounded-md border border-border-strong bg-surface-raised py-1 text-[12.5px] text-ink shadow-[0_10px_30px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[11.5px] font-medium text-ink-muted">GitHub sync</span>
          <SyncBadge file={file} />
        </div>
        <div className="space-y-1.5 text-[12px] text-ink-muted">
          <div className="flex items-center justify-between gap-3">
            <span>Updated</span>
            <span className="shrink-0 text-ink-subtle">{formatBrainDate(file.updatedAt)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Synced</span>
            <span className="shrink-0 text-ink-subtle">
              {file.githubSyncedAt ? formatBrainDate(file.githubSyncedAt) : "Not yet"}
            </span>
          </div>
          {shortSha ? (
            <div className="flex items-center justify-between gap-3">
              <span>Commit</span>
              <span className="shrink-0 font-mono text-[11.5px] text-ink-subtle">{shortSha}</span>
            </div>
          ) : null}
        </div>
        {file.githubSyncError ? (
          <div className="mt-2 rounded-md border border-danger-border bg-danger-bg px-2 py-1.5 text-[11.5px] leading-4 text-danger">
            {file.githubSyncError}
          </div>
        ) : null}
      </div>
      <ContextMenuDivider />
      <ContextMenuButton
        destructive
        disabled={deleteDisabled}
        icon={<Trash2 size={13} strokeWidth={1.8} />}
        label={deleteDisabled ? "Deleting..." : "Delete"}
        onClick={onDelete}
      />
    </div>
  );
}

function SyncBadge({ file }: { file: BrainFile }) {
  const status = syncStatus(file.githubSyncStatus);
  const Icon = status.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${status.className}`}
    >
      <Icon
        size={11}
        strokeWidth={2}
        className={
          file.githubSyncStatus === "pending" || file.githubSyncStatus === "syncing"
            ? "animate-spin"
            : ""
        }
      />
      {status.label}
    </span>
  );
}

function FileIcon({ path }: { path: string }) {
  if (isCodePath(path)) {
    return <FileCode2 size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />;
  }
  return <FileText size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />;
}

function BrainContextMenu({
  state,
  files,
  onCreateFile,
  onCreateFolder,
  onRenameFile,
  onRenameFolder,
  onDeleteFile,
  onDeleteFolder,
  onClose,
}: {
  state: NonNullable<ContextMenuState>;
  files: BrainFile[];
  onCreateFile: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onRenameFile: (file: BrainFile) => void;
  onRenameFolder: (path: string) => void;
  onDeleteFile: (file: BrainFile) => void;
  onDeleteFolder: (path: string) => void;
  onClose: () => void;
}) {
  const file =
    state.target.type === "file" ? files.find((item) => item.path === state.target.path) : null;
  const folderPath = state.target.type === "folder" ? state.target.path : "";
  const createContextPath =
    state.target.type === "file" ? parentFolderPath(state.target.path) : folderPath;

  function run(action: () => void) {
    onClose();
    action();
  }

  return (
    <div
      className="fixed z-[90] min-w-[152px] overflow-hidden rounded-md border border-border-strong bg-surface-raised py-1 text-[12.5px] text-ink shadow-[0_10px_30px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
      style={{ left: state.x, top: state.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {state.target.type !== "file" ? (
        <>
          <ContextMenuButton
            icon={<FilePlus2 size={13} strokeWidth={1.8} />}
            label="New File"
            onClick={() => run(() => onCreateFile(createContextPath))}
          />
          <ContextMenuButton
            icon={<FolderPlus size={13} strokeWidth={1.8} />}
            label="New Folder"
            onClick={() => run(() => onCreateFolder(createContextPath))}
          />
          <ContextMenuDivider />
        </>
      ) : null}
      {file ? (
        <>
          <ContextMenuButton
            icon={<Pencil size={13} strokeWidth={1.8} />}
            label="Rename"
            onClick={() => run(() => onRenameFile(file))}
          />
          <ContextMenuButton
            destructive
            icon={<Trash2 size={13} strokeWidth={1.8} />}
            label="Delete"
            onClick={() => run(() => onDeleteFile(file))}
          />
        </>
      ) : null}
      {state.target.type === "folder" ? (
        <>
          <ContextMenuButton
            icon={<Pencil size={13} strokeWidth={1.8} />}
            label="Rename"
            onClick={() => run(() => onRenameFolder(state.target.path))}
          />
          <ContextMenuButton
            destructive
            icon={<Trash2 size={13} strokeWidth={1.8} />}
            label="Delete"
            onClick={() => run(() => onDeleteFolder(state.target.path))}
          />
        </>
      ) : null}
    </div>
  );
}

function ContextMenuButton({
  icon,
  label,
  destructive,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={`flex h-7 w-full items-center gap-2 px-2.5 text-left transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-45 ${
        destructive ? "text-danger" : "text-ink"
      }`}
    >
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function ContextMenuDivider() {
  return <div className="my-1 h-px bg-surface-subtle" />;
}

function draggedBrainItem(event: React.DragEvent): BrainDragItem | null {
  const raw = event.dataTransfer.getData(BRAIN_TREE_DRAG_MIME);
  if (raw) {
    try {
      const item = JSON.parse(raw) as Partial<BrainDragItem>;
      if ((item.type === "file" || item.type === "folder") && typeof item.path === "string") {
        return { type: item.type, path: item.path };
      }
    } catch {
      return null;
    }
  }

  const path = event.dataTransfer.getData("text/plain");
  return path ? { type: "file", path } : null;
}

function dropFolderForNode(node: BrainTreeNode<BrainFile>) {
  return node.type === "folder" ? node.path : parentFolderPath(node.path);
}

function canDropItemOnFolder(item: BrainDragItem | null, folderPath: string) {
  if (!item) return false;
  if (item.type === "file") return parentFolderPath(item.path) !== folderPath;
  return (
    item.path !== folderPath &&
    parentFolderPath(item.path) !== folderPath &&
    !folderPath.startsWith(`${item.path}/`)
  );
}

function titleFromPath(path: string) {
  return (
    path
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "")
      .replace(/[-_]+/g, " ") || "New note"
  );
}

function uniqueNewBrainFilePath(files: BrainFile[], contextPath = "") {
  const existing = new Set(files.map((file) => file.path));
  const folder = normalizeCreateFolderContext(files, contextPath);
  const prefix = folder ? `${folder}/` : "";

  for (let index = 1; index < 100; index += 1) {
    const name = index === 1 ? "new-note.md" : `new-note-${index}.md`;
    const path = `${prefix}${name}`;
    if (!existing.has(path)) return path;
  }

  return `${prefix}new-note-${Date.now()}.md`;
}

function uniqueNewBrainFolderPath(files: BrainFile[], contextPath = "") {
  const existingFolders = new Set(files.flatMap((file) => ancestorFolderPaths(file.path)));
  const parent = normalizeCreateFolderContext(files, contextPath);
  const prefix = parent ? `${parent}/` : "";

  for (let index = 1; index < 100; index += 1) {
    const name = index === 1 ? "new-folder" : `new-folder-${index}`;
    const path = `${prefix}${name}`;
    if (!existingFolders.has(path)) return path;
  }

  return `${prefix}new-folder-${Date.now()}`;
}

function normalizeCreateFolderContext(files: BrainFile[], contextPath: string) {
  const normalized = contextPath.replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  if (files.some((file) => file.path === normalized)) return parentFolderPath(normalized);
  return normalized;
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createOptimisticBrainFile(path: string, content: string): BrainFile {
  return {
    path,
    content,
    sizeBytes: brainContentSize(content),
    contentHash: "",
    githubCommitSha: null,
    githubSyncedAt: null,
    githubSyncStatus: "pending",
    githubSyncError: null,
    updatedAt: new Date().toISOString(),
  };
}

function optimisticRenameBrainFile(
  files: BrainFile[],
  fromPath: string,
  toPath: string,
  content?: string,
) {
  return sortBrainFiles(
    files.map((file) =>
      file.path === fromPath ? optimisticBrainFileAtPath(file, toPath, content) : file,
    ),
  );
}

function optimisticMoveBrainFolder(
  files: BrainFile[],
  fromPath: string,
  toPath: string,
  draftPath?: string,
  draftContent?: string,
) {
  return sortBrainFiles(
    files.map((file) => {
      if (!file.path.startsWith(`${fromPath}/`)) return file;
      const nextPath = `${toPath}/${file.path.slice(fromPath.length + 1)}`;
      const content = draftPath === file.path ? draftContent : undefined;
      return optimisticBrainFileAtPath(file, nextPath, content);
    }),
  );
}

function optimisticBrainFileAtPath(file: BrainFile, path: string, content = file.content) {
  return {
    ...file,
    path,
    content,
    sizeBytes: brainContentSize(content),
    githubCommitSha: null,
    githubSyncedAt: null,
    githubSyncStatus: "pending",
    githubSyncError: null,
    updatedAt: new Date().toISOString(),
  };
}

function sortBrainFiles(files: BrainFile[]) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

function brainContentSize(content: string) {
  return new TextEncoder().encode(content).byteLength;
}

function isMarkdownPath(path: string) {
  return /\.(md|mdx)$/i.test(path);
}

function isCodePath(path: string) {
  return /\.(ts|tsx|js|jsx|json|css|html|yaml|yml)$/i.test(path);
}

function syncStatus(status: string) {
  if (status === "failed") {
    return {
      label: "Needs attention",
      icon: CircleAlert,
      className: "border-danger-border bg-danger-bg text-danger",
    };
  }
  if (status === "pending" || status === "syncing") {
    return {
      label: status === "syncing" ? "Committing" : "Queued",
      icon: Loader2,
      className: "border-warning-border bg-warning-bg text-warning",
    };
  }
  return {
    label: "Synced",
    icon: CheckCircle2,
    className: "border-success-border bg-success-bg text-success",
  };
}

function formatBrainDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

// Always-visible "Updated 2 hours ago" label in the file header. The relative
// label is friendliest for "when did this last change"; the exact date is one
// hover away. suppressHydrationWarning: the relative value is computed against
// the wall clock, which can differ by a tick between SSR and hydration.
function BrainUpdatedAt({ updatedAt }: { updatedAt: string }) {
  const parsed = new Date(updatedAt);
  const isValid = !Number.isNaN(parsed.getTime());
  return (
    <time
      dateTime={isValid ? parsed.toISOString() : undefined}
      title={isValid ? `Last updated ${formatBrainDate(updatedAt)}` : undefined}
      suppressHydrationWarning
      className="shrink-0 whitespace-nowrap text-[11.5px] text-ink-subtle"
    >
      Updated {formatBrainRelativeTime(updatedAt)}
    </time>
  );
}
