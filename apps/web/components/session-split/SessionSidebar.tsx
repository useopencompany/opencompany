"use client";

import { GripVertical } from "lucide-react";
import { useLayout } from "react-splitkit";
import {
  openSessionIds,
  type SessionSummary,
  writeSessionDragPayload,
} from "@/types/session-layout";
import { useSessionDrag } from "./SessionDragContext";

export function SessionSidebar({ sessions }: { sessions: SessionSummary[] }) {
  const { layout } = useLayout();
  const { startDrag, endDrag } = useSessionDrag();
  const open = openSessionIds(layout);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-border border-r bg-sidebar">
      <div className="px-4 pt-4 pb-2 font-semibold text-[11px] text-ink-subtle uppercase tracking-wide">
        Sessions
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {sessions.map((session) => (
          <div
            key={session.id}
            draggable
            onDragStart={(event) => {
              writeSessionDragPayload(event.dataTransfer, session);
              // Defer the state flip so the browser captures the drag image
              // before React re-renders (a synchronous re-render during
              // dragstart cancels the drag in some browsers).
              setTimeout(() => startDrag(session), 0);
            }}
            onDragEnd={endDrag}
            className="group flex cursor-grab items-center gap-2 rounded-md px-2 py-[5px] text-[13px] text-ink/90 transition-colors duration-150 hover:bg-surface-hover hover:text-ink active:cursor-grabbing"
          >
            <GripVertical
              size={12}
              strokeWidth={1.8}
              className="shrink-0 text-ink-subtle opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            />
            <span className="min-w-0 flex-1 truncate tracking-[-0.005em]">{session.name}</span>
            {open.has(session.id) ? (
              <span
                title="Open in a pane"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
              />
            ) : null}
          </div>
        ))}
      </div>
      <p className="border-border border-t px-4 py-3 text-[11px] text-ink-subtle leading-relaxed">
        Drag a session onto a pane — it splits toward the edge nearest the cursor.
      </p>
    </aside>
  );
}
