"use client";

import { createContext, useContext } from "react";

type WorkspaceContextValue = {
  workspaceId: string;
  userId: string;
  // Per-user "Codex runtime" feature flag, seeded server-side from `users.codexEngineEnabled`.
  // Gates the engine selector in the agent editor so Codex is hidden unless the user opts in.
  codexEngineEnabled: boolean;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  children,
  workspaceId,
  userId,
  codexEngineEnabled = false,
}: {
  children: React.ReactNode;
  workspaceId: string;
  userId: string;
  codexEngineEnabled?: boolean;
}) {
  return (
    <WorkspaceContext.Provider value={{ workspaceId, userId, codexEngineEnabled }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaceContext() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspaceContext must be used within WorkspaceProvider.");
  }
  return context;
}
