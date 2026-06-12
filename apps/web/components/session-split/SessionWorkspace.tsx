"use client";

import { useState } from "react";
import { LayoutProvider, type TabRegistry } from "react-splitkit";
import {
  createEmptyLayout,
  getSessionMeta,
  SESSION_TAB_TYPE,
  type SessionSummary,
} from "@/types/session-layout";
import { SessionDragProvider } from "./SessionDragContext";
import { SessionLayout } from "./SessionLayout";
import { SessionPane } from "./SessionPane";
import { SessionSidebar } from "./SessionSidebar";

const registry: TabRegistry = {
  [SESSION_TAB_TYPE]: {
    tabType: SESSION_TAB_TYPE,
    title: "Session",
    availableInAddMenu: false,
    render: (tab) => {
      const meta = getSessionMeta(tab);
      return meta ? (
        <SessionPane sessionId={meta.sessionId} sessionName={meta.sessionName} />
      ) : null;
    },
  },
};

/**
 * Top-level split-screen workspace: sidebar (drag sources) + pane canvas.
 *
 * `LayoutProvider` wraps both so the sidebar can read the layout tree (to mark
 * already-open sessions) while the canvas dispatches split/close actions. To
 * persist layouts later, pass `onChange` and rehydrate via `initialLayout` —
 * the tree is plain JSON.
 */
export function SessionWorkspace({ sessions }: { sessions: SessionSummary[] }) {
  const [initialLayout] = useState(createEmptyLayout);

  return (
    <LayoutProvider initialLayout={initialLayout} registry={registry}>
      <SessionDragProvider>
        <div className="flex h-full min-h-0 w-full">
          <SessionSidebar sessions={sessions} />
          <SessionLayout />
        </div>
      </SessionDragProvider>
    </LayoutProvider>
  );
}
