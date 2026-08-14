"use client";

import type { EngineRuntimeStatus } from "@opencompany/protocol";
import { cn } from "@opencompany/ui/lib/utils";
import {
  AppWindow,
  ExternalLink,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelRightClose,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import dynamic from "next/dynamic";
import {
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createEngineRuntimeAccess } from "@/lib/headless-chat-commands";

const CodingWorkspaceTerminal = dynamic(() => import("./CodingWorkspaceTerminal"), {
  ssr: false,
  loading: () => <WorkspaceNotice title="Loading terminal…" busy />,
});

const MIN_PANEL_WIDTH = 340;
const MAX_PANEL_WIDTH = 760;
const DEFAULT_PANEL_WIDTH = 440;
const PANEL_WIDTH_KEY = "goat-coding-workspace-panel-width-v1";
const PANEL_WIDTH_EVENT = "goat-coding-workspace-panel-width";
const WORKSPACE_CONNECTION_TIMEOUT_MS = 150_000;

type WorkspaceTab = "preview" | "terminal";
type ConnectionState = "dormant" | "waking" | "ready" | "disconnected" | "error";
type PreviewPort = { port: number; isHttp: boolean; score: number };

export type CodingWorkspacePanelHandle = {
  toggle: () => void;
};

export const CodingWorkspacePanel = forwardRef(function CodingWorkspacePanel(
  {
    chatSessionId,
    sandboxStatus,
    engineLabel,
    onExpandedChange,
    onRequestFocusReturn,
  }: {
    chatSessionId: string;
    sandboxStatus: EngineRuntimeStatus | null;
    engineLabel: string;
    onExpandedChange?: (expanded: boolean) => void;
    onRequestFocusReturn?: () => void;
  },
  ref: Ref<CodingWorkspacePanelHandle>,
) {
  const [expanded, setExpanded] = useState(false);
  const [mobilePanelOpened, setMobilePanelOpened] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const persistedWidth = useSyncExternalStore(
    subscribePanelWidth,
    readPersistedPanelWidth,
    defaultPanelWidth,
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? persistedWidth;
  const isNarrow = useSyncExternalStore(
    subscribeNarrowLayout,
    readNarrowLayout,
    serverNarrowLayout,
  );
  const panelExpanded = expanded && (!isNarrow || mobilePanelOpened);
  const [activeTab, setActiveTab] = useState<WorkspaceTab | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("dormant");
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [ports, setPorts] = useState<PreviewPort[]>([]);
  const [portsLoaded, setPortsLoaded] = useState(false);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [manualPort, setManualPort] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const connectAttemptRef = useRef(0);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedPortRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusOnCollapseRef = useRef(false);

  const clearConnectionTimeout = useCallback(() => {
    if (connectionTimeoutRef.current === null) return;
    clearTimeout(connectionTimeoutRef.current);
    connectionTimeoutRef.current = null;
  }, []);

  const disconnect = useCallback(() => {
    connectAttemptRef.current += 1;
    clearConnectionTimeout();
    socketRef.current?.close();
    socketRef.current = null;
    setSocket(null);
  }, [clearConnectionTimeout]);

  useEffect(
    () => () => {
      connectAttemptRef.current += 1;
      clearConnectionTimeout();
      socketRef.current?.close();
      socketRef.current = null;
    },
    [clearConnectionTimeout],
  );

  const requestPreview = useCallback((port: number, targetSocket = socketRef.current) => {
    if (targetSocket?.readyState !== WebSocket.OPEN) return;
    selectedPortRef.current = port;
    setSelectedPort(port);
    setPreviewUrl(null);
    targetSocket.send(JSON.stringify({ type: "preview.open", port }));
  }, []);

  const connect = useCallback(
    async (tab: WorkspaceTab) => {
      const attempt = connectAttemptRef.current + 1;
      connectAttemptRef.current = attempt;
      clearConnectionTimeout();
      socketRef.current?.close();
      socketRef.current = null;
      setSocket(null);
      setConnectionState("waking");
      setError(null);
      setPortsLoaded(false);

      try {
        const access = await createEngineRuntimeAccess(chatSessionId);
        if (connectAttemptRef.current !== attempt) return;

        const nextSocket = new WebSocket(access.websocketUrl, [
          "goat-coding-workspace-v1",
          `goat-ticket.${access.ticket}`,
        ]);
        nextSocket.binaryType = "arraybuffer";
        socketRef.current = nextSocket;
        const connectionTimeout = setTimeout(() => {
          if (connectAttemptRef.current !== attempt || nextSocket.readyState === WebSocket.OPEN) {
            return;
          }
          if (connectionTimeoutRef.current === connectionTimeout) {
            connectionTimeoutRef.current = null;
          }
          connectAttemptRef.current += 1;
          socketRef.current = null;
          nextSocket.close();
          setSocket(null);
          setConnectionState("error");
          setError("The workspace took too long to connect. Try again.");
        }, WORKSPACE_CONNECTION_TIMEOUT_MS);
        connectionTimeoutRef.current = connectionTimeout;
        const clearAttemptTimeout = () => {
          clearTimeout(connectionTimeout);
          if (connectionTimeoutRef.current === connectionTimeout) {
            connectionTimeoutRef.current = null;
          }
        };
        nextSocket.addEventListener("open", () => {
          if (connectAttemptRef.current !== attempt) return nextSocket.close();
          clearAttemptTimeout();
          setSocket(nextSocket);
          setConnectionState("ready");
          if (tab === "preview") nextSocket.send(JSON.stringify({ type: "ports.refresh" }));
        });
        nextSocket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const message = parseControlMessage(event.data);
          if (!message) return;
          if (message.type === "ports") {
            setPorts(message.ports);
            setPortsLoaded(true);
            setError(null);
            const strongest = message.ports.find((port) => port.isHttp);
            if (strongest && selectedPortRef.current === null) {
              requestPreview(strongest.port, nextSocket);
            }
          } else if (message.type === "preview") {
            selectedPortRef.current = message.port;
            setSelectedPort(message.port);
            setPreviewUrl(message.url);
            setPreviewRevision(0);
            setError(null);
          } else if (message.type === "error") {
            setError(message.message);
            setPortsLoaded(true);
          } else if (message.type === "status" && message.status === "disconnected") {
            setConnectionState("disconnected");
          }
        });
        nextSocket.addEventListener("close", (event) => {
          clearAttemptTimeout();
          if (connectAttemptRef.current !== attempt) return;
          setSocket(null);
          // The runner completes the handshake and closes with a 4xxx code + reason when
          // the workspace itself is unavailable (deleted sandbox, missing tools, …).
          if (event.code >= 4000 && event.reason) {
            setConnectionState("error");
            setError(event.reason);
            return;
          }
          setConnectionState((current) => (current === "waking" ? "error" : "disconnected"));
        });
        nextSocket.addEventListener("error", () => {
          if (connectAttemptRef.current === attempt) {
            setError("The workspace connection was lost.");
          }
        });
      } catch (connectError) {
        if (connectAttemptRef.current !== attempt) return;
        clearConnectionTimeout();
        setConnectionState("error");
        setError(
          connectError instanceof Error ? connectError.message : "Unable to open this workspace.",
        );
      }
    },
    [chatSessionId, clearConnectionTimeout, requestPreview],
  );

  const selectTab = (tab: WorkspaceTab) => {
    setExpanded(true);
    setMobilePanelOpened(true);
    setActiveTab(tab);
    setError(null);
    if (connectionState === "ready" && socketRef.current?.readyState === WebSocket.OPEN) {
      if (tab === "preview") {
        setPortsLoaded(false);
        socketRef.current.send(JSON.stringify({ type: "ports.refresh" }));
      }
      return;
    }
    void connect(tab);
  };

  const collapse = useCallback(() => {
    restoreFocusOnCollapseRef.current = true;
    disconnect();
    setExpanded(false);
    setMobilePanelOpened(false);
    setFullscreen(false);
    setConnectionState("dormant");
    setActiveTab(null);
  }, [disconnect]);

  useEffect(() => {
    if (panelExpanded || !restoreFocusOnCollapseRef.current) return;
    restoreFocusOnCollapseRef.current = false;
    onRequestFocusReturn?.();
  }, [panelExpanded, onRequestFocusReturn]);

  useEffect(() => {
    onExpandedChange?.(panelExpanded);
  }, [panelExpanded, onExpandedChange]);

  useImperativeHandle(
    ref,
    () => ({
      toggle: () => {
        if (panelExpanded) {
          collapse();
          return;
        }
        setExpanded(true);
        setMobilePanelOpened(true);
      },
    }),
    [collapse, panelExpanded],
  );

  useEffect(() => {
    if (!panelExpanded || (!isNarrow && !fullscreen)) return;
    const panel = panelRef.current;
    if (!panel) return;

    const frame = window.requestAnimationFrame(() => {
      focusableElements(panel)[0]?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        collapse();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [collapse, fullscreen, isNarrow, panelExpanded]);

  if (!panelExpanded) {
    return null;
  }

  return (
    <aside
      ref={panelRef}
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-hidden border-l border-border bg-surface shadow-[-8px_0_24px_rgba(15,15,15,0.03)]",
        "max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:h-auto max-lg:w-auto max-lg:border-0 max-lg:shadow-ring-xl",
        fullscreen &&
          "fixed inset-0 z-50 h-dvh w-screen border-0 max-lg:inset-0 max-lg:rounded-none",
      )}
      style={fullscreen || isNarrow ? undefined : { width }}
      role={fullscreen || isNarrow ? "dialog" : undefined}
      aria-modal={fullscreen || isNarrow ? true : undefined}
      aria-label={`${engineLabel} workspace`}
      onKeyDown={(event) => {
        if ((!isNarrow && !fullscreen) || event.key !== "Tab") return;
        trapFocus(panelRef.current, event);
      }}
    >
      {!fullscreen && !isNarrow ? (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize workspace panel"
          aria-valuemin={MIN_PANEL_WIDTH}
          aria-valuemax={MAX_PANEL_WIDTH}
          aria-valuenow={width}
          className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize hover:bg-ink/10 max-lg:hidden"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowLeft" ? 1 : -1;
            persistPanelWidth(
              Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width + direction * 20)),
            );
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            const startX = event.clientX;
            const startWidth = width;
            let nextWidth = startWidth;
            const onMove = (moveEvent: PointerEvent) => {
              nextWidth = Math.min(
                MAX_PANEL_WIDTH,
                Math.max(MIN_PANEL_WIDTH, startWidth + startX - moveEvent.clientX),
              );
              setDragWidth(nextWidth);
            };
            const onUp = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              persistPanelWidth(nextWidth);
              setDragWidth(null);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp, { once: true });
          }}
        />
      ) : null}

      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          onClick={() => selectTab("preview")}
          aria-pressed={activeTab === "preview"}
          className={tabClass(activeTab === "preview")}
        >
          <AppWindow size={14} /> Preview
        </button>
        <button
          type="button"
          onClick={() => selectTab("terminal")}
          aria-pressed={activeTab === "terminal"}
          className={tabClass(activeTab === "terminal")}
        >
          <TerminalSquare size={14} /> Terminal
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <PanelButton
            label={fullscreen ? "Exit fullscreen" : "Fullscreen workspace"}
            onClick={() => setFullscreen((current) => !current)}
          >
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </PanelButton>
          <PanelButton label="Collapse workspace" onClick={collapse}>
            <PanelRightClose size={15} />
          </PanelButton>
        </div>
      </header>

      {connectionState === "ready" && error ? (
        <p
          className="border-b border-danger-border bg-danger-bg px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === null ? (
          <WorkspaceNotice
            title={workspaceStateTitle(sandboxStatus)}
            detail="Choose Preview or Terminal to wake and connect to this workspace. Opening the panel alone keeps a sleeping sandbox dormant."
          />
        ) : connectionState === "waking" ? (
          <WorkspaceNotice
            title={sandboxStatus === "sleeping" ? "Waking workspace…" : "Connecting…"}
            detail="This can take a few seconds after the sandbox has paused."
            busy
          />
        ) : connectionState === "error" || connectionState === "disconnected" ? (
          <WorkspaceNotice
            title={connectionState === "disconnected" ? "Connection lost" : "Workspace unavailable"}
            detail={error ?? "Reconnect to restore the terminal and preview."}
            actionLabel="Retry"
            onAction={() => void connect(activeTab)}
          />
        ) : connectionState === "ready" && socket ? (
          activeTab === "terminal" ? (
            <div className="min-h-0 flex-1 bg-[#11130f]">
              <CodingWorkspaceTerminal socket={socket} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2">
                <select
                  aria-label="Preview port"
                  value={selectedPort ?? ""}
                  onChange={(event) => requestPreview(Number(event.target.value))}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-canvas px-2 text-[12px] text-ink outline-none"
                >
                  {ports.length === 0 ? (
                    <option value="">No ports found</option>
                  ) : selectedPort === null ? (
                    <option value="">Select a port</option>
                  ) : null}
                  {ports.map((port) => (
                    <option key={port.port} value={port.port}>
                      localhost:{port.port}
                      {port.isHttp ? " · HTTP" : ""}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Manual preview port"
                  inputMode="numeric"
                  placeholder="Port"
                  value={manualPort}
                  onChange={(event) => setManualPort(event.target.value.replace(/\D/g, ""))}
                  className="h-8 w-16 rounded-md border border-border bg-canvas px-2 text-[12px] text-ink outline-none"
                />
                <PanelButton
                  label="Open manual port"
                  disabled={!isValidManualPort(manualPort)}
                  onClick={() => requestPreview(Number(manualPort))}
                >
                  Go
                </PanelButton>
                <PanelButton
                  label="Refresh ports"
                  onClick={() => {
                    setPortsLoaded(false);
                    socket.send(JSON.stringify({ type: "ports.refresh" }));
                  }}
                >
                  <RefreshCw size={14} />
                </PanelButton>
                <PanelButton
                  label="Refresh preview"
                  disabled={!previewUrl}
                  onClick={() => setPreviewRevision((current) => current + 1)}
                >
                  <RefreshCw size={14} />
                </PanelButton>
                <PanelButton
                  label="Open preview in new tab"
                  disabled={!previewUrl}
                  onClick={() =>
                    previewUrl && window.open(previewUrl, "_blank", "noopener,noreferrer")
                  }
                >
                  <ExternalLink size={14} />
                </PanelButton>
              </div>
              {previewUrl ? (
                <iframe
                  key={`${previewUrl}:${previewRevision}`}
                  src={previewUrl}
                  title={`${engineLabel} preview on port ${selectedPort ?? "unknown"}`}
                  sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                  referrerPolicy="no-referrer"
                  className="min-h-0 flex-1 bg-white"
                />
              ) : (
                <WorkspaceNotice
                  title={
                    !portsLoaded
                      ? "Looking for development servers…"
                      : ports.some((port) => port.isHttp)
                        ? "Opening preview…"
                        : "No development server detected"
                  }
                  detail={
                    !portsLoaded
                      ? `Checking listening ports in the ${engineLabel} workspace.`
                      : !ports.some((port) => port.isHttp)
                        ? `Start a server from ${engineLabel} or Terminal, then refresh ports. opencompany never runs package scripts automatically.`
                        : "Connecting through the secure preview gateway."
                  }
                  busy={!portsLoaded}
                />
              )}
            </div>
          )
        ) : (
          <WorkspaceNotice title="Preparing workspace…" busy />
        )}
      </div>
    </aside>
  );
});

function subscribePanelWidth(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(PANEL_WIDTH_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PANEL_WIDTH_EVENT, onChange);
  };
}

function persistPanelWidth(width: number) {
  window.localStorage.setItem(PANEL_WIDTH_KEY, String(width));
  window.dispatchEvent(new Event(PANEL_WIDTH_EVENT));
}

function readPersistedPanelWidth() {
  const storedValue = window.localStorage.getItem(PANEL_WIDTH_KEY);
  if (storedValue === null || storedValue.trim() === "") return DEFAULT_PANEL_WIDTH;
  const value = Number(storedValue);
  return Number.isFinite(value)
    ? Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, value))
    : DEFAULT_PANEL_WIDTH;
}

function defaultPanelWidth() {
  return DEFAULT_PANEL_WIDTH;
}

function subscribeNarrowLayout(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia("(max-width: 1023px)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function readNarrowLayout() {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 1023px)").matches
    : false;
}

function serverNarrowLayout() {
  // Prefer the non-blocking rail during SSR; desktop expands immediately after hydration.
  return true;
}

function WorkspaceNotice({
  title,
  detail,
  busy = false,
  actionLabel,
  onAction,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
      <div className="flex max-w-xs flex-col items-center gap-2">
        {busy ? <LoaderCircle size={18} className="animate-spin text-ink-subtle" /> : null}
        <p className="text-[13px] font-medium text-ink">{title}</p>
        {detail ? <p className="text-[12px] leading-5 text-ink-subtle">{detail}</p> : null}
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="mt-2 rounded-md border border-border bg-canvas px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-hover"
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PanelButton({
  label,
  children,
  disabled = false,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-[11px] font-medium text-ink-subtle hover:bg-surface-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
}

function trapFocus(container: HTMLElement | null, event: ReactKeyboardEvent<HTMLElement>) {
  if (!container) return;
  const elements = focusableElements(container);
  const first = elements[0];
  const last = elements.at(-1);
  if (!first || !last) return;

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function tabClass(active: boolean) {
  return cn(
    "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors",
    active ? "bg-canvas text-ink" : "text-ink-subtle hover:bg-surface-hover hover:text-ink",
  );
}

function workspaceStateTitle(status: EngineRuntimeStatus | null) {
  if (status === "sleeping") return "Workspace is sleeping";
  if (status === "running") return "Workspace is ready";
  if (status === "deleted") return "Workspace was deleted";
  return "Workspace not started";
}

function isValidManualPort(value: string) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1_024 && port <= 65_535;
}

type RuntimeMessage =
  | { type: "ports"; ports: PreviewPort[] }
  | { type: "preview"; port: number; url: string }
  | { type: "error"; message: string }
  | { type: "status"; status: string };

function parseControlMessage(raw: string): RuntimeMessage | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.type === "ports" && Array.isArray(value.ports)) {
      const ports = value.ports.filter(isPreviewPort);
      return { type: "ports", ports };
    }
    if (
      value.type === "preview" &&
      typeof value.port === "number" &&
      typeof value.url === "string" &&
      isHttpUrl(value.url)
    ) {
      return { type: "preview", port: value.port, url: value.url };
    }
    if (value.type === "error" && typeof value.message === "string") {
      return { type: "error", message: value.message };
    }
    if (value.type === "status" && typeof value.status === "string") {
      return { type: "status", status: value.status };
    }
    return null;
  } catch {
    return null;
  }
}

function isHttpUrl(value: string) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isPreviewPort(value: unknown): value is PreviewPort {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.port === "number" &&
    typeof candidate.isHttp === "boolean" &&
    typeof candidate.score === "number"
  );
}
