"use client";

import { createContext, useContext, useMemo } from "react";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { type Collections, createCollections } from "@/lib/collections";

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
