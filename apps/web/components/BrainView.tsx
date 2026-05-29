"use client";

import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Heading1,
  Heading2,
  Italic,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createBrainFile,
  deleteBrainFile,
  deleteBrainFolder,
  renameBrainFile,
  renameBrainFolder,
  updateBrainFile,
} from "@/lib/brain/actions";
import {
  brainFileRenameSelectionEnd,
  fileNameFromPath,
  resolveBrainFileRenameName,
} from "@/lib/brain/file-names";
import {
  ancestorFolderPaths,
  type BrainTreeNode,
  buildBrainTree,
  collectFolderPaths,
  type FlatBrainNode,
  flattenVisibleTree,
  parentFolderPath,
} from "@/lib/brain/tree";
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

export default function BrainView({ files: serverFiles }: { files: BrainFile[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [files, setFiles] = useState(serverFiles);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState(serverFiles[0]?.path ?? "");
  const [selectedContextPath, setSelectedContextPath] = useState(
    serverFiles[0] ? parentFolderPath(serverFiles[0].path) : "",
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(serverFiles[0] ? ancestorFolderPaths(serverFiles[0].path) : []),
  );
  const [focusedPath, setFocusedPath] = useState(serverFiles[0]?.path ?? "");
  const [treeHasFocus, setTreeHasFocus] = useState(false);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const [draftContent, setDraftContent] = useState(serverFiles[0]?.content ?? "");
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

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

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
            selectedPathRef.current = updateResult.path;
            setSelectedPath(updateResult.path);
            setFocusedPath(updateResult.path);
            setSelectedContextPath(parentFolderPath(updateResult.path));
            expandAncestors(updateResult.path);
          }
          setAutoSaveState("idle");
          router.refresh();
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
    [expandAncestors, router],
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

  function updateSelectedPath(path: string) {
    selectedPathRef.current = path;
    setSelectedPath(path);
    if (path) setFocusedPath(path);
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
    startTransition(async () => {
      try {
        const result = await createBrainFile(path, content);
        if (!result.ok) {
          restoreBrainViewSnapshot(snapshot);
          cancelRenameFile();
          setError(result.error);
          return;
        }
        if (result.path !== path) {
          setFiles((currentFiles) => optimisticRenameBrainFile(currentFiles, path, result.path));
          updateSelectedPath(result.path);
          setSelectedContextPath(parentFolderPath(result.path));
          expandAncestors(result.path);
          setRenamingPath((current) => (current === path ? result.path : current));
          setRenamingName(fileNameFromPath(result.path));
        }
        router.refresh();
      } catch (error) {
        restoreBrainViewSnapshot(snapshot);
        cancelRenameFile();
        handleBrainActionError(error, "Create failed.");
      } finally {
        finishOptimisticMutation();
      }
    });
  }

  function createFolder(contextPath = selectedContextPath) {
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
    startTransition(async () => {
      try {
        const result = await createBrainFile(path, content);
        if (!result.ok) {
          restoreBrainViewSnapshot(snapshot);
          cancelRenameFile();
          setError(result.error);
          return;
        }
        if (result.path !== path) {
          setFiles((currentFiles) => optimisticRenameBrainFile(currentFiles, path, result.path));
          updateSelectedPath(result.path);
          setSelectedContextPath(parentFolderPath(result.path));
          expandAncestors(result.path);
          const resolvedFolder = parentFolderPath(result.path);
          setRenamingPath((current) => (current === folderPath ? resolvedFolder : current));
          setRenamingName(fileNameFromPath(resolvedFolder));
        }
        router.refresh();
      } catch (error) {
        restoreBrainViewSnapshot(snapshot);
        cancelRenameFile();
        handleBrainActionError(error, "Create failed.");
      } finally {
        finishOptimisticMutation();
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

        const result = await renameBrainFile(file.path, nextPath);
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
        router.refresh();
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

        const result = await renameBrainFolder(folderPath, nextPath);
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
        router.refresh();
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
        router.refresh();
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
        router.refresh();
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
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[#eaeae6] bg-canvas/85 px-5 backdrop-blur-md">
          {selected ? (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px]">
                <FileIcon path={selected.path} />
                <span title={selected.path} className="min-w-0 truncate font-medium text-ink">
                  {fileNameFromPath(selected.path)}
                </span>
              </div>
              <div ref={fileMenuRef} className="relative ml-auto shrink-0">
                <button
                  type="button"
                  aria-label="Open file actions"
                  aria-expanded={fileMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setFileMenuOpen((open) => !open)}
                  className={`flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-[#ececea] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                    fileMenuOpen ? "bg-[#e3e3df] text-ink" : ""
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
                <div className="mb-4 rounded-md border border-[#f1b8ae] bg-[#fff7f5] px-3 py-2 text-[12px] text-[#9f2f21]">
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
            Create a Brain file to start adding long-lived context.
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
    <aside className="flex h-full w-[292px] shrink-0 flex-col border-r border-[#e6e6e3] bg-[#f4f4f1]">
      <div className="border-b border-[#e6e6e3] px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#111] text-white shadow-[0_1px_2px_rgba(0,0,0,0.16)]">
            <FileText size={14} strokeWidth={1.9} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-ink">Project brain</div>
            <div className="mt-0.5 text-[11.5px] text-ink-muted">{files.length} files</div>
          </div>
          <button
            type="button"
            aria-label="Create brain file"
            title="Create brain file"
            onClick={() => onCreateFile()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-[#ececea] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <FilePlus2 size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="Create brain folder"
            title="Create brain folder"
            onClick={() => onCreateFolder()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-[#ececea] hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <FolderPlus size={15} strokeWidth={1.8} />
          </button>
        </div>
        <label className="mt-3 flex h-8 items-center gap-2 rounded-md border border-[#e4e4e0] bg-white px-2.5 text-[12.5px] text-ink-muted shadow-[0_1px_0_rgba(0,0,0,0.02)]">
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
          dropTargetPath === "" ? "bg-[#ededeb]" : ""
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
      ? "bg-[#d9d9d4] text-ink ring-1 ring-[#b9b9b1]"
      : active
        ? "bg-[#dfdfda] text-ink"
        : focused
          ? "bg-[#ececea] text-ink ring-1 ring-[#cfcfc8]"
          : contextActive
            ? "bg-[#ebebe7] text-ink"
            : "text-ink/85 hover:bg-[#ececea] hover:text-ink"
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
            className="h-[21px] min-w-0 flex-1 rounded-[3px] border border-[#bdbdb7] bg-white px-1.5 font-mono text-[12px] text-ink outline-none"
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
            if (!node.file) return;
            event.preventDefault();
            onStartRename(node.file);
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

function MarkdownBrainEditor({
  content,
  onChange,
}: {
  content: string;
  onChange: (content: string) => void;
}) {
  const [isEmpty, setIsEmpty] = useState(content.trim().length === 0);
  const [, refreshToolbar] = useState(0);
  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        StarterKit,
        Markdown.configure({
          indentation: { style: "space", size: 2 },
          markedOptions: { gfm: true, breaks: false },
        }),
      ],
      content,
      contentType: "markdown",
      editorProps: {
        attributes: {
          class:
            "tiptap-brain min-h-[560px] w-full pb-20 text-[15px] leading-7 text-ink outline-none",
        },
      },
      onCreate: ({ editor }) => {
        setIsEmpty(editor.isEmpty);
      },
      onSelectionUpdate: () => {
        refreshToolbar((value) => value + 1);
      },
      onUpdate: ({ editor }) => {
        setIsEmpty(editor.isEmpty);
        refreshToolbar((value) => value + 1);
        onChange(editor.getMarkdown());
      },
    },
    [],
  );

  return (
    <div className="relative">
      {editor ? (
        <BubbleMenu
          editor={editor}
          className="flex items-center gap-0.5 rounded-lg border border-black/[0.08] bg-[#fbfbfa] p-1 shadow-[0_12px_28px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
        >
          <FormatButton
            label="Heading 1"
            active={editor.isActive("heading", { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 size={14} strokeWidth={1.8} />
          </FormatButton>
          <FormatButton
            label="Heading 2"
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 size={14} strokeWidth={1.8} />
          </FormatButton>
          <Divider />
          <FormatButton
            label="Bold"
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold size={14} strokeWidth={1.9} />
          </FormatButton>
          <FormatButton
            label="Italic"
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic size={14} strokeWidth={1.9} />
          </FormatButton>
          <FormatButton
            label="Inline code"
            active={editor.isActive("code")}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            <Code size={14} strokeWidth={1.9} />
          </FormatButton>
        </BubbleMenu>
      ) : null}

      <div className="relative">
        {isEmpty ? (
          <div className="pointer-events-none absolute left-0 top-0 text-[15px] leading-7 text-ink-subtle/70">
            Start writing...
          </div>
        ) : null}
        <EditorContent editor={editor} />
      </div>
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
      className="min-h-[560px] w-full resize-y rounded-md border border-[#dfdfda] bg-white px-4 py-3 font-mono text-[12.5px] leading-6 text-ink outline-none focus:border-[#cfcfc8]"
    />
  );
}

function FormatButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
  onClick: () => void | boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-35 ${
        active ? "bg-[#e3e3df] text-ink" : "text-ink-muted hover:bg-[#ececea] hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-[#deded9]" />;
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
      className="absolute right-0 top-full z-[200] mt-1 w-[244px] overflow-hidden rounded-md border border-[#d8d8d2] bg-[#fbfbfa] py-1 text-[12.5px] text-ink shadow-[0_10px_30px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
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
          <div className="mt-2 rounded-md border border-[#f1b8ae] bg-[#fff7f5] px-2 py-1.5 text-[11.5px] leading-4 text-[#9f2f21]">
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
      className="fixed z-[90] min-w-[152px] overflow-hidden rounded-md border border-[#d8d8d2] bg-[#fbfbfa] py-1 text-[12.5px] text-ink shadow-[0_10px_30px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.08)]"
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
      className={`flex h-7 w-full items-center gap-2 px-2.5 text-left transition-colors hover:bg-[#ececea] disabled:cursor-not-allowed disabled:opacity-45 ${
        destructive ? "text-[#a33a2d]" : "text-ink"
      }`}
    >
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function ContextMenuDivider() {
  return <div className="my-1 h-px bg-[#e5e5df]" />;
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
      className: "border-[#f0c0b8] bg-[#fff5f3] text-[#a33929]",
    };
  }
  if (status === "pending" || status === "syncing") {
    return {
      label: status === "syncing" ? "Committing" : "Queued",
      icon: Loader2,
      className: "border-[#eadcb6] bg-[#fff8e7] text-[#795b19]",
    };
  }
  return {
    label: "Synced",
    icon: CheckCircle2,
    className: "border-[#cfe5d5] bg-[#f0f8f2] text-[#216b35]",
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
