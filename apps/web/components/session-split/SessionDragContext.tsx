"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SessionSummary } from "@/types/session-layout";

const FLASH_DURATION_MS = 600;

type SessionDragContextValue = {
  /** Session currently being dragged from the sidebar (null when idle). */
  dragging: SessionSummary | null;
  dragVersion: number;
  startDrag: (session: SessionSummary) => void;
  endDrag: () => void;
  /** Pane to flash when a dropped session is already open there. */
  flashPanelId: string | null;
  flashPanel: (panelId: string) => void;
};

const SessionDragContext = createContext<SessionDragContextValue | null>(null);

export function SessionDragProvider({ children }: { children: ReactNode }) {
  const [dragging, setDragging] = useState<SessionSummary | null>(null);
  const [dragVersion, setDragVersion] = useState(0);
  const [flashPanelId, setFlashPanelId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const startDrag = useCallback((session: SessionSummary) => {
    setDragging(session);
    setDragVersion((current) => current + 1);
  }, []);
  const endDrag = useCallback(() => setDragging(null), []);

  const flashPanel = useCallback((panelId: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashPanelId(panelId);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      setFlashPanelId(null);
    }, FLASH_DURATION_MS);
  }, []);

  const value = useMemo(
    () => ({ dragging, dragVersion, startDrag, endDrag, flashPanelId, flashPanel }),
    [dragging, dragVersion, startDrag, endDrag, flashPanelId, flashPanel],
  );

  return <SessionDragContext.Provider value={value}>{children}</SessionDragContext.Provider>;
}

export function useSessionDrag() {
  const context = useContext(SessionDragContext);
  if (!context) throw new Error("useSessionDrag must be used within SessionDragProvider");
  return context;
}

/**
 * Null outside a provider. For components (e.g. the real sidebar) that add
 * drag affordances only when a split surface is mounted around them.
 */
export function useOptionalSessionDrag() {
  return useContext(SessionDragContext);
}
