"use client";

import { createContext, useContext } from "react";

type WorkspaceContextValue = {
  workspaceId: string;
  userId: string;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  children,
  workspaceId,
  userId,
}: {
  children: React.ReactNode;
  workspaceId: string;
  userId: string;
}) {
  return (
    <WorkspaceContext.Provider value={{ workspaceId, userId }}>
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
