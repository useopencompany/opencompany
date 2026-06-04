"use client";

import { createContext, useContext, useMemo } from "react";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import {
  type Collections,
  type SessionCollections,
  createCollections,
  createSessionCollections,
} from "@/lib/collections";

const CollectionsContext = createContext<Collections | null>(null);

export function CollectionsProvider({ children }: { children: React.ReactNode }) {
  const { workspaceId } = useWorkspaceContext();
  // Rebuild every collection when the workspace changes so no stale-workspace
  // rows leak across a switch. Collections are inert until a live query
  // subscribes, so creating them here opens no network connections.
  const collections = useMemo(() => createCollections(workspaceId), [workspaceId]);

  return (
    <CollectionsContext.Provider value={collections}>{children}</CollectionsContext.Provider>
  );
}

export function useCollections(): Collections {
  const context = useContext(CollectionsContext);
  if (!context) {
    throw new Error("useCollections must be used within CollectionsProvider.");
  }
  return context;
}

// Module-level cache so the same session's collections are reused across
// component mounts/re-renders (a fresh collection would re-subscribe a new
// shape stream). Keyed by workspace+session; survives navigation between
// sessions and back.
const sessionCollectionsCache = new Map<string, SessionCollections>();

/**
 * Lazily create (and cache) the per-session message/event collections for one
 * session. Only the rows for the open session are synced.
 */
export function useSessionCollections(sessionId: string): SessionCollections {
  const { workspaceId } = useCollections();
  return useMemo(() => {
    const cacheKey = `${workspaceId}:${sessionId}`;
    const existing = sessionCollectionsCache.get(cacheKey);
    if (existing) return existing;
    const created = createSessionCollections(workspaceId, sessionId);
    sessionCollectionsCache.set(cacheKey, created);
    return created;
  }, [workspaceId, sessionId]);
}
