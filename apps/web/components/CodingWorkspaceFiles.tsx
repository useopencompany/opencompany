"use client";

import { cn } from "@opencompany/ui/lib/utils";
import { ChevronsDownUp, PanelLeftClose, PanelLeftOpen, RotateCw } from "lucide-react";
import dynamic from "next/dynamic";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ancestorDirectoryPaths,
  formatFileSize,
  parentDirectoryPath,
  parseWorkspaceFileMessage,
  type WorkspaceFileContent,
} from "@/lib/coding-workspace-files";
import { PanelButton, WorkspaceNotice } from "./CodingWorkspaceControls";
import { CodingWorkspaceFileTree, type WorkspaceDirectoryState } from "./CodingWorkspaceFileTree";

const CodingWorkspaceCodeEditor = dynamic(() => import("./CodingWorkspaceCodeEditor"), {
  ssr: false,
  loading: () => <WorkspaceNotice title="Loading editor…" busy />,
});

const MIN_TREE_WIDTH = 140;
const MAX_TREE_WIDTH = 420;
const DEFAULT_TREE_WIDTH = 196;
const LAYOUT_KEY = "goat-coding-workspace-files-layout-v1";
const SAVED_INDICATOR_MS = 2_000;

/** An open text file plus the edit in progress on top of it. */
type FileBuffer = {
  content: string;
  baseContent: string;
  baseRevision: string;
  editable: boolean;
};

type OpenFileState =
  | { status: "loading" }
  /** Text lives in `buffers` so an unsaved edit survives switching files. */
  | { status: "text"; editable: boolean }
  | { status: "preview"; content: Exclude<WorkspaceFileContent, { kind: "text" }> }
  | { status: "error"; message: string };

type SaveState =
  | { status: "idle" | "saving" | "saved" }
  | { status: "conflict" | "failed"; message: string };

type PersistedLayout = {
  expandedPaths?: string[];
  selectedPath?: string | null;
  treeWidth?: number;
  treeVisible?: boolean;
};

export default function CodingWorkspaceFiles({
  socket,
  sessionKey,
  rootLabel,
  active,
}: {
  socket: WebSocket;
  /** Scopes the remembered tree layout to one coding session. */
  sessionKey: string;
  rootLabel: string;
  /** False while another workspace tab is showing. The component stays mounted so an
   *  unsaved edit survives a trip to the terminal. */
  active: boolean;
}) {
  const layoutKey = `${LAYOUT_KEY}:${sessionKey}`;
  // The panel only mounts this on the client, so the remembered layout can seed the
  // initial state directly instead of racing a restore effect against the first save.
  const [layout] = useState(() => readLayout(layoutKey));
  const [directories, setDirectories] = useState<Map<string, WorkspaceDirectoryState>>(new Map());
  const [expandedPaths, setExpandedPaths] = useState(
    // Ancestors of the remembered file are expanded too, so it is visible in the tree
    // rather than merely open in the editor.
    () =>
      new Set([
        ...(layout.expandedPaths ?? []),
        ...ancestorDirectoryPaths(layout.selectedPath ?? ""),
      ]),
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(layout.selectedPath ?? null);
  const [activePath, setActivePath] = useState<string | null>(layout.selectedPath ?? null);
  const [openFile, setOpenFile] = useState<OpenFileState | null>(
    layout.selectedPath ? { status: "loading" } : null,
  );
  const [buffers, setBuffers] = useState<Map<string, FileBuffer>>(new Map());
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [treeWidth, setTreeWidth] = useState(() =>
    clampTreeWidth(layout.treeWidth ?? DEFAULT_TREE_WIDTH),
  );
  const [treeVisible, setTreeVisible] = useState(layout.treeVisible ?? true);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const selectedPathRef = useRef<string | null>(layout.selectedPath ?? null);
  const expandedPathsRef = useRef<ReadonlySet<string>>(expandedPaths);
  const savingRef = useRef(false);
  // What the in-flight save sent, so `files.saved` can make exactly that text the new
  // baseline and leave keystrokes that landed mid-save dirty.
  const pendingSaveRef = useRef<{ path: string; content: string } | null>(null);
  // Declared before every other effect so the requests below always read fresh values.
  useEffect(() => {
    selectedPathRef.current = selectedPath;
    expandedPathsRef.current = expandedPaths;
    savingRef.current = saveState.status === "saving";
  });

  const send = useCallback(
    (message: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    [socket],
  );

  const requestListing = useCallback(
    (path: string) => {
      // Entries already on screen stay put while the listing is refetched. Blanking them
      // would collapse the whole tree for a frame on every refresh.
      setDirectories((current) =>
        current.get(path)?.status === "ready"
          ? current
          : new Map(current).set(path, { status: "loading" }),
      );
      send({ type: "files.list", path });
    },
    [send],
  );

  /** Keeps only unsaved work and the file being opened, so browsing stays bounded. */
  const pruneBuffers = useCallback((keepPath: string) => {
    setBuffers((current) => {
      const next = new Map(
        [...current].filter(
          ([path, buffer]) => path === keepPath || buffer.content !== buffer.baseContent,
        ),
      );
      return next.size === current.size ? current : next;
    });
  }, []);

  const openPath = useCallback(
    (path: string) => {
      pruneBuffers(path);
      setSelectedPath(path);
      setActivePath(path);
      setSaveState({ status: "idle" });
      setOpenFile({ status: "loading" });
      send({ type: "files.open", path });
    },
    [pruneBuffers, send],
  );

  /** Opens a file from the tree, reusing an unsaved edit instead of discarding it. */
  const selectFile = useCallback(
    (path: string) => {
      setActivePath(path);
      if (path === selectedPathRef.current) return;
      const buffer = buffers.get(path);
      if (!buffer) {
        openPath(path);
        return;
      }
      pruneBuffers(path);
      setSelectedPath(path);
      setSaveState({ status: "idle" });
      setOpenFile({ status: "text", editable: buffer.editable });
    },
    [buffers, openPath, pruneBuffers],
  );

  const toggleDirectory = useCallback(
    (path: string, expand: boolean) => {
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (expand) next.add(path);
        else next.delete(path);
        return next;
      });
      // Always refetch: a cached listing renders instantly and is corrected in place if
      // the agent has since changed the folder.
      if (expand) requestListing(path);
    },
    [requestListing],
  );

  // Load the tree the remembered layout describes. Re-runs when the socket is replaced,
  // so a reconnect rebuilds the tree from the sandbox.
  useEffect(() => {
    for (const path of ["", ...expandedPathsRef.current]) requestListing(path);
    if (selectedPathRef.current) openPath(selectedPathRef.current);
  }, [openPath, requestListing]);

  useEffect(() => {
    writeLayout(layoutKey, {
      expandedPaths: [...expandedPaths],
      selectedPath,
      treeWidth,
      treeVisible,
    });
  }, [layoutKey, expandedPaths, selectedPath, treeWidth, treeVisible]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = parseWorkspaceFileMessage(event.data);
      if (!message) return;

      if (message.type === "files.listing") {
        setDirectories((current) =>
          new Map(current).set(message.path, {
            status: "ready",
            entries: message.entries,
            truncated: message.truncated,
          }),
        );
        return;
      }

      if (message.type === "files.error" && message.scope === "list") {
        setDirectories((current) =>
          new Map(current).set(message.path, { status: "error", message: message.message }),
        );
        return;
      }

      // A completed save has to reach its buffer even if the user has moved on, or the
      // stored revision goes stale and the next save reports a phantom conflict.
      if (message.type === "files.saved") {
        const saved = pendingSaveRef.current;
        pendingSaveRef.current = null;
        setBuffers((current) => {
          const buffer = current.get(message.path);
          if (!buffer || saved?.path !== message.path) return current;
          return new Map(current).set(message.path, {
            ...buffer,
            baseContent: saved.content,
            baseRevision: message.revision,
          });
        });
        if (message.path === selectedPathRef.current) setSaveState({ status: "saved" });
        return;
      }

      // A reply for a file the user has already navigated away from is stale.
      if (message.path !== selectedPathRef.current) return;

      if (message.type === "files.content") {
        if (message.kind !== "text") {
          setOpenFile({ status: "preview", content: message });
          return;
        }
        setBuffers((current) =>
          new Map(current).set(message.path, {
            content: message.content,
            baseContent: message.content,
            baseRevision: message.revision,
            editable: message.editable,
          }),
        );
        setOpenFile({ status: "text", editable: message.editable });
        return;
      }

      if (message.scope === "open") {
        setOpenFile({ status: "error", message: message.message });
        return;
      }
      setSaveState({
        status: message.code === "conflict" ? "conflict" : "failed",
        message: message.message,
      });
    };

    socket.addEventListener("message", onMessage);
    return () => socket.removeEventListener("message", onMessage);
  }, [socket]);

  useEffect(() => {
    if (saveState.status !== "saved") return;
    const timeout = setTimeout(() => setSaveState({ status: "idle" }), SAVED_INDICATOR_MS);
    return () => clearTimeout(timeout);
  }, [saveState.status]);

  const buffer = selectedPath === null ? undefined : buffers.get(selectedPath);
  const dirty = Boolean(buffer && buffer.content !== buffer.baseContent);
  const unsavedPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const [path, candidate] of buffers) {
      if (candidate.content !== candidate.baseContent) paths.add(path);
    }
    return paths;
  }, [buffers]);

  const save = useCallback(
    (overwrite = false) => {
      const path = selectedPathRef.current;
      if (path === null || savingRef.current) return;
      const current = buffers.get(path);
      if (!current || !current.editable || current.content === current.baseContent) return;
      // Set eagerly rather than waiting for the state to commit, so a Cmd+S that reaches
      // both the editor keymap and this component cannot send the document twice.
      savingRef.current = true;
      pendingSaveRef.current = { path, content: current.content };
      setSaveState({ status: "saving" });
      send({
        type: "files.save",
        path,
        content: current.content,
        baseRevision: overwrite ? null : current.baseRevision,
      });
    },
    [buffers, send],
  );

  const refreshTree = useCallback(() => {
    for (const path of ["", ...expandedPathsRef.current]) requestListing(path);
  }, [requestListing]);

  // Coming back from Terminal or Preview re-reads the tree, because the agent has very
  // likely changed it in the meantime. The open buffer is deliberately left alone: a
  // silent reload would discard an unsaved edit, and a stale save is caught by the
  // revision check instead.
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (becameActive) refreshTree();
  }, [active, refreshTree]);

  const onContentChange = useCallback((path: string, content: string) => {
    setBuffers((current) => {
      const existing = current.get(path);
      if (!existing || existing.content === content) return current;
      return new Map(current).set(path, { ...existing, content });
    });
    setSaveState((current) => (current.status === "saved" ? { status: "idle" } : current));
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // CodeMirror already handled and prevented its own Mod-s; this covers the tree and
    // the toolbar, where no editor has focus.
    if (event.defaultPrevented || event.key.toLowerCase() !== "s") return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    save();
  };

  const width = dragWidth ?? treeWidth;

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col bg-canvas", !active && "hidden")}
      hidden={!active}
      onKeyDown={onKeyDown}
      data-testid="workspace-files"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-border border-b px-1.5">
        <PanelButton
          label={treeVisible ? "Hide file tree" : "Show file tree"}
          onClick={() => setTreeVisible((current) => !current)}
        >
          {treeVisible ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </PanelButton>
        {selectedPath === null ? (
          <p className="min-w-0 flex-1 truncate text-[12px] text-ink-subtle">{rootLabel}</p>
        ) : (
          <p
            className="flex min-w-0 flex-1 items-baseline gap-px text-[12px]"
            title={selectedPath}
            data-testid="workspace-files-path"
          >
            <span className="min-w-0 truncate text-ink-subtle">
              {parentDirectoryPath(selectedPath) && `${parentDirectoryPath(selectedPath)}/`}
            </span>
            <span className="shrink-0 text-ink">{selectedPath.split("/").at(-1)}</span>
            {dirty ? (
              <span className="shrink-0 pl-1 text-ink-subtle" aria-label="Unsaved changes">
                •
              </span>
            ) : null}
          </p>
        )}
        {saveState.status === "saved" ? (
          <span className="shrink-0 px-1 text-[11px] text-ink-subtle">Saved</span>
        ) : null}
        {openFile?.status === "text" && openFile.editable ? (
          <button
            type="button"
            onClick={() => save()}
            disabled={!dirty || saveState.status === "saving"}
            className="h-7 shrink-0 rounded-md border border-border bg-surface px-2.5 font-medium text-[12px] text-ink hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-40"
          >
            {saveState.status === "saving" ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>

      {saveState.status === "conflict" || saveState.status === "failed" ? (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-danger-border border-b bg-danger-bg px-3 py-2 text-[12px] text-danger"
        >
          <p className="min-w-0 flex-1">{saveState.message}</p>
          {saveState.status === "conflict" ? (
            <>
              <button
                type="button"
                onClick={() => selectedPath && openPath(selectedPath)}
                className="font-medium underline underline-offset-2"
              >
                Discard mine and reload
              </button>
              <button
                type="button"
                onClick={() => save(true)}
                className="font-medium underline underline-offset-2"
              >
                Save anyway
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {treeVisible ? (
          <>
            <aside
              className="flex min-h-0 shrink-0 flex-col border-border border-r"
              style={{ width }}
            >
              <div className="flex h-8 shrink-0 items-center gap-0.5 border-border-subtle border-b pr-0.5 pl-2.5">
                <p className="min-w-0 flex-1 truncate font-medium text-[11px] text-ink-subtle uppercase tracking-wide">
                  {rootLabel}
                </p>
                <PanelButton
                  label="Collapse all folders"
                  onClick={() => setExpandedPaths(new Set())}
                >
                  <ChevronsDownUp size={13} />
                </PanelButton>
                <PanelButton label="Refresh files" onClick={refreshTree}>
                  <RotateCw size={13} />
                </PanelButton>
              </div>
              <CodingWorkspaceFileTree
                rootLabel={rootLabel}
                directories={directories}
                expandedPaths={expandedPaths}
                selectedPath={selectedPath}
                unsavedPaths={unsavedPaths}
                activePath={activePath}
                onActivePathChange={setActivePath}
                onToggleDirectory={toggleDirectory}
                onOpenFile={selectFile}
              />
            </aside>
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize file tree"
              aria-valuemin={MIN_TREE_WIDTH}
              aria-valuemax={MAX_TREE_WIDTH}
              aria-valuenow={width}
              className="-ml-px z-10 w-[3px] shrink-0 cursor-col-resize hover:bg-ink/10"
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setTreeWidth(clampTreeWidth(width + (event.key === "ArrowRight" ? 16 : -16)));
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                const startX = event.clientX;
                const startWidth = width;
                let nextWidth = startWidth;
                const onMove = (moveEvent: PointerEvent) => {
                  nextWidth = clampTreeWidth(startWidth + moveEvent.clientX - startX);
                  setDragWidth(nextWidth);
                };
                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  setTreeWidth(nextWidth);
                  setDragWidth(null);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp, { once: true });
              }}
            />
          </>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <FileViewer
            active={active}
            openFile={openFile}
            path={selectedPath}
            buffer={buffer}
            onChange={onContentChange}
            onSave={() => save()}
            onReload={() => selectedPath && openPath(selectedPath)}
          />
        </div>
      </div>
    </div>
  );
}

function FileViewer({
  active,
  openFile,
  path,
  buffer,
  onChange,
  onSave,
  onReload,
}: {
  active: boolean;
  openFile: OpenFileState | null;
  path: string | null;
  buffer: FileBuffer | undefined;
  onChange: (path: string, content: string) => void;
  onSave: () => void;
  onReload: () => void;
}) {
  if (openFile === null || path === null) {
    return (
      <WorkspaceNotice
        title="No file open"
        detail="Pick a file on the left to read it, edit it, and save it back into the workspace."
      />
    );
  }
  if (openFile.status === "loading") return <WorkspaceNotice title="Opening file…" busy />;
  if (openFile.status === "error") {
    return (
      <WorkspaceNotice
        title="This file could not be opened"
        detail={openFile.message}
        actionLabel="Try again"
        onAction={onReload}
      />
    );
  }
  if (openFile.status === "preview") {
    const content = openFile.content;
    if (content.kind === "image") {
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-surface-muted p-6">
          {
            // biome-ignore lint/performance/noImgElement: an inline sandbox data URL cannot be optimised.
            // eslint-disable-next-line @next/next/no-img-element -- same reason
            <img
              src={content.dataUrl}
              alt={path}
              className="max-h-full max-w-full object-contain"
            />
          }
          <p className="text-[11px] text-ink-subtle">{formatFileSize(content.size)}</p>
        </div>
      );
    }
    return content.kind === "binary" ? (
      <WorkspaceNotice
        title="Binary file"
        detail={`This is ${formatFileSize(content.size)} of binary data. Open it from the Terminal tab instead.`}
      />
    ) : (
      <WorkspaceNotice
        title="Too large to open here"
        detail={`${formatFileSize(content.size)} is beyond what the panel editor loads. Read it from the Terminal tab instead.`}
      />
    );
  }

  return (
    <>
      {openFile.editable ? null : (
        <p className="shrink-0 border-border border-b bg-surface-muted px-3 py-1.5 text-[11px] text-ink-subtle">
          Read-only — this file is too large to save from the panel.
        </p>
      )}
      <CodingWorkspaceCodeEditor
        key={path}
        path={path}
        active={active}
        initialContent={buffer?.content ?? ""}
        readOnly={!openFile.editable}
        onChange={(content) => onChange(path, content)}
        onSave={onSave}
      />
    </>
  );
}

function clampTreeWidth(width: number) {
  return Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, Math.round(width)));
}

function readLayout(key: string): PersistedLayout {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as PersistedLayout;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLayout(key: string, layout: PersistedLayout) {
  try {
    window.localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    // A storage quota or private-mode failure only costs the remembered layout.
  }
}
