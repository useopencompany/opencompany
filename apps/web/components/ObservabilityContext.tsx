"use client";

import { setObservabilityContext } from "@opencompany/observability";
import { useEffect } from "react";

type Props = {
  userId: string;
  workspaceId: string;
};

export function ObservabilityContext({ userId, workspaceId }: Props) {
  useEffect(() => {
    setObservabilityContext({
      user_id: userId,
      workspace_id: workspaceId,
    });

    return () => {
      setObservabilityContext(undefined);
    };
  }, [userId, workspaceId]);

  return null;
}
