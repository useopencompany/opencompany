"use client";

import { useEffect, useState } from "react";
import { getHeadlessTaskSummary } from "@/lib/headless-task-commands";

export type GoatTaskSummary = {
  cost: {
    hasRecordedCosts: boolean;
    totalCostUsdMicros: number;
  };
  durationMs: number | null;
};

type GoatTaskSummaryState = {
  requestKey: string;
  summary: GoatTaskSummary | null;
  error: Error | null;
};

export function useGoatTaskSummary(taskId: string, terminal: boolean) {
  const requestKey = `${taskId}:${terminal}`;
  const [state, setState] = useState<GoatTaskSummaryState | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getHeadlessTaskSummary(taskId, {
      fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }),
    })
      .then((summary) => {
        setState({ requestKey, summary: summary as GoatTaskSummary | null, error: null });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          requestKey,
          summary: null,
          error: error instanceof Error ? error : new Error("Could not load task summary."),
        });
      });

    return () => controller.abort();
  }, [requestKey, taskId]);

  const current = state?.requestKey === requestKey ? state : null;
  return {
    summary: current?.summary ?? null,
    error: current?.error ?? null,
  };
}
