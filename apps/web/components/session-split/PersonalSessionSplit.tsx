"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LayoutProvider, type TabRegistry, useLayout } from "react-splitkit";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import SessionView from "@/components/SessionView";
import {
  createEmptyLayout,
  createSessionLayout,
  findPanelIdBySessionId,
  firstPanelId,
  getSessionMeta,
  replacePanelSession,
  SESSION_TAB_TYPE,
  type SessionSummary,
} from "@/types/session-layout";
import { SessionDragProvider, useSessionDrag } from "./SessionDragContext";
import { SessionLayout } from "./SessionLayout";

// Each pane hosts a full live SessionView — the same component the session
// route rendered directly before split support.
const registry: TabRegistry = {
  [SESSION_TAB_TYPE]: {
    tabType: SESSION_TAB_TYPE,
    title: "Session",
    availableInAddMenu: false,
    render: (tab) => {
      const meta = getSessionMeta(tab);
      return meta ? <SessionView sessionId={meta.sessionId} /> : null;
    },
  },
};

// --- Open requests (sidebar click → pane) ----------------------------------
//
// Sidebar clicks both navigate (URL stays meaningful) and post an "open this
// session" request here. The canvas consumes requests: flash the pane if the
// session is already open, otherwise swap it into the first pane. Routing
// alone can't express this — clicking a session whose pane was closed leaves
// the URL unchanged, so no navigation event fires.

type OpenSessionRequest = { session: SessionSummary; nonce: number };

type OpenSessionContextValue = {
  request: OpenSessionRequest | null;
  openSession: (session: SessionSummary) => void;
  clearRequest: () => void;
};

const OpenSessionContext = createContext<OpenSessionContextValue | null>(null);

/** Null outside a provider — lets the sidebar work on surfaces without split panes. */
export function useOptionalOpenSession() {
  return useContext(OpenSessionContext);
}

const SESSION_PATH_PATTERN = /^\/personal\/session\/([^/]+)/;

// useLayoutEffect (so layout syncs land before paint — no empty-pane flash on
// the first in-app navigation to a session) without the SSR warning.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Mounts the split-layout store for the personal surface. Lives in
 * PersonalShell so the pane arrangement survives navigation between personal
 * routes; the canvas (session route) renders it, the sidebar drags into it.
 */
export function PersonalSplitProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { initialSessions } = usePersonalAgent();

  // Seed the layout from the current route so a deep link / refresh paints the
  // routed session immediately (no empty-pane flash). Computed once at shell
  // mount — SSR and hydration see the same pathname, so this is render-stable.
  const [initialLayout] = useState(() => {
    const match = pathname.match(SESSION_PATH_PATTERN);
    if (!match?.[1]) return createEmptyLayout();
    const id = decodeURIComponent(match[1]);
    const title = initialSessions.find((session) => session.id === id)?.title ?? "Session";
    return createSessionLayout({ id, name: title });
  });

  const [request, setRequest] = useState<OpenSessionRequest | null>(null);
  const openSession = useCallback((session: SessionSummary) => {
    setRequest((prev) => ({ session, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const clearRequest = useCallback(() => setRequest(null), []);
  const openValue = useMemo(
    () => ({ request, openSession, clearRequest }),
    [request, openSession, clearRequest],
  );

  return (
    <LayoutProvider initialLayout={initialLayout} registry={registry}>
      <SessionDragProvider>
        <OpenSessionContext.Provider value={openValue}>{children}</OpenSessionContext.Provider>
      </SessionDragProvider>
    </LayoutProvider>
  );
}

/**
 * The session route's main area: the split-pane canvas. Keeps the routed
 * session and sidebar open-requests in sync with the layout tree.
 */
export function PersonalSessionCanvas({ sessionId }: { sessionId: string }) {
  const { layout, dispatch } = useLayout();
  const { flashPanel } = useSessionDrag();
  const open = useOptionalOpenSession();
  const { initialSessions } = usePersonalAgent();

  // Route → layout: make sure the routed session is visible. Runs once per
  // sessionId (the ref guard) so closing its pane afterwards sticks — the
  // layout is the source of truth between navigations.
  const ensuredRef = useRef<string | null>(null);
  // Session id the route-ensure just inserted. The open-request effect consumes
  // this to skip the "already open" flash on a plain navigation (the click's
  // request would otherwise always find the session present — ensure runs first).
  const insertedByEnsureRef = useRef<string | null>(null);
  useIsomorphicLayoutEffect(() => {
    if (ensuredRef.current === sessionId) return;
    ensuredRef.current = sessionId;
    if (findPanelIdBySessionId(layout, sessionId)) return;
    const targetPanelId = firstPanelId(layout);
    if (!targetPanelId) return;
    const title = initialSessions.find((session) => session.id === sessionId)?.title ?? "Session";
    const next = replacePanelSession(layout, targetPanelId, { id: sessionId, name: title });
    if (next) {
      insertedByEnsureRef.current = sessionId;
      dispatch({ type: "REPLACE_LAYOUT", layout: next });
    }
  }, [sessionId, layout, initialSessions, dispatch]);

  // Sidebar click → layout: flash if it was already open, else swap into the
  // first pane. Runs after the route-ensure layout effect in the same commit.
  useEffect(() => {
    if (!open?.request) return;
    const { session } = open.request;
    const existingPanelId = findPanelIdBySessionId(layout, session.id);
    if (existingPanelId) {
      if (insertedByEnsureRef.current === session.id) {
        // Present only because this click's navigation just inserted it — not
        // a duplicate, no flash.
        insertedByEnsureRef.current = null;
      } else {
        flashPanel(existingPanelId);
      }
    } else {
      const targetPanelId = firstPanelId(layout);
      if (targetPanelId) {
        const next = replacePanelSession(layout, targetPanelId, session);
        if (next) dispatch({ type: "REPLACE_LAYOUT", layout: next });
      }
    }
    open.clearRequest();
  }, [open, layout, dispatch, flashPanel]);

  return <SessionLayout showHeaderWhenSingle={false} />;
}
