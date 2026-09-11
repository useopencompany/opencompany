"use client";

import { useEffect, useRef } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { markHeadlessTaskSeen } from "@/lib/headless-task-commands";

/**
 * Clears a Task's unread result once the reader is actually looking at it.
 *
 * A settled run raises the same unread flag a finished chat turn does, on the same column of the
 * same table, so the dot has to clear the same way: from the surface that renders the result. The
 * review queue used to be the only surface that acknowledged one, and it is behind a flag, so a
 * Task read from its own route kept its dot forever.
 *
 * Acknowledgment waits for the document to be visible. Restoring a background tab is what makes a
 * result read, not the navigation that queued it up behind ten other tabs.
 *
 * A Task's read state is workspace-wide, unlike a chat's: the flag lives once on the Task's
 * conversation and every member reads the same row, so one member opening a Task clears its dot
 * for the team. That follows the Task itself being shared work rather than anyone's private
 * thread. Per-reader Task read state would need its own table, not a change here.
 */
export function useTaskSeenAcknowledgement(taskId: string | null) {
  const { unreadTaskIds, workspace } = useAppData();
  const unread = taskId !== null && unreadTaskIds.has(taskId);
  const acknowledged = useRef<string | null>(null);

  useEffect(() => {
    if (!taskId || !unread) {
      // A later result on the same Task raises the flag again and has to be acknowledged again.
      acknowledged.current = null;
      return;
    }
    const markSeenIfVisible = () => {
      if (document.visibilityState === "hidden" || acknowledged.current === taskId) return;
      acknowledged.current = taskId;
      void markHeadlessTaskSeen(taskId, { scopeKey: workspace.id }).catch((error: unknown) => {
        // Leaving the Task unread is the safe direction, so this is logged rather than surfaced:
        // clearing the guard lets the next visit retry.
        if (acknowledged.current === taskId) acknowledged.current = null;
        console.warn("Could not mark a task result as seen.", { taskId, error });
      });
    };
    markSeenIfVisible();
    document.addEventListener("visibilitychange", markSeenIfVisible);
    return () => document.removeEventListener("visibilitychange", markSeenIfVisible);
  }, [taskId, unread, workspace.id]);
}
