"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { type Dispatch, type SetStateAction, useEffect, useMemo } from "react";
import { useHydrated } from "@/components/useHydrated";
import type { ConversationRuntimeView } from "@/lib/chat-ui";
import {
  type EngineSandboxState,
  PENDING_ENGINE_SANDBOX_STATE,
  resolvedEngineSandboxState,
  unavailableEngineSandboxState,
} from "@/lib/engine-sandbox-state";
import {
  getHeadlessChatEngineSession,
  type HeadlessChatEngineSessionReadModel,
} from "@/lib/headless-chat-collections";
import { getEngineRuntimeStatus } from "@/lib/headless-chat-commands";

const SANDBOX_STATUS_POLL_INTERVAL_MS = 30_000;

export function ConversationRuntimeSync({
  conversationId,
  setSandboxState,
  setRuntime,
  pollSandbox,
}: {
  conversationId: string;
  setSandboxState: Dispatch<SetStateAction<EngineSandboxState>>;
  setRuntime: Dispatch<SetStateAction<ConversationRuntimeView | null>>;
  pollSandbox: boolean;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return (
    <ConversationRuntimeSubscriber
      conversationId={conversationId}
      setSandboxState={setSandboxState}
      setRuntime={setRuntime}
      pollSandbox={pollSandbox}
    />
  );
}

function ConversationRuntimeSubscriber({
  conversationId,
  setSandboxState,
  setRuntime,
  pollSandbox,
}: {
  conversationId: string;
  setSandboxState: Dispatch<SetStateAction<EngineSandboxState>>;
  setRuntime: Dispatch<SetStateAction<ConversationRuntimeView | null>>;
  pollSandbox: boolean;
}) {
  // The engine session shape streams flat status columns, so Electric partial updates merge
  // per column. The nested Conversation runtime object cannot offer that: a partial update
  // carrying only runtime_updated_at replaced the whole object and dropped its status.
  const engineSession = useMemo(
    () => getHeadlessChatEngineSession(conversationId),
    [conversationId],
  );
  const {
    data: rows,
    isLoading,
    isError,
  } = useLiveQuery((q) => q.from({ engineSession }), [engineSession]);
  const row =
    ((rows ?? []) as HeadlessChatEngineSessionReadModel[]).find(
      (candidate) => candidate.conversationId === conversationId,
    ) ?? null;
  const runtime = useMemo<ConversationRuntimeView | null>(
    () =>
      row
        ? {
            status: row.status,
            activeRunId: row.activeRunId,
            hasError: row.error !== null,
            updatedAt: row.updatedAt,
          }
        : null,
    [row],
  );

  useEffect(() => {
    // Preserve the authoritative server snapshot until this detail shape has a valid row.
    if (isLoading || isError || !row) return;
    // Keep state identity stable across live-query emissions that carry no runtime change.
    setRuntime((previous) =>
      previous &&
      runtime &&
      previous.status === runtime.status &&
      previous.activeRunId === runtime.activeRunId &&
      previous.hasError === runtime.hasError &&
      previous.updatedAt === runtime.updatedAt
        ? previous
        : runtime,
    );
  }, [isError, isLoading, row, runtime, setRuntime]);

  useEffect(() => {
    if (!pollSandbox) {
      setSandboxState(PENDING_ENGINE_SANDBOX_STATE);
      return;
    }

    const controller = new AbortController();
    let active = true;
    let requestPending = false;

    const loadStatus = async () => {
      if (requestPending) return;
      requestPending = true;
      try {
        const runtimeStatus = await getEngineRuntimeStatus(conversationId, {
          fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }),
        });
        if (!active) return;
        setSandboxState((previous) =>
          previous.kind === "resolved" && previous.status === runtimeStatus
            ? previous
            : resolvedEngineSandboxState(runtimeStatus),
        );
      } catch {
        if (active) setSandboxState(unavailableEngineSandboxState);
      } finally {
        requestPending = false;
      }
    };

    void loadStatus();
    const interval = setInterval(() => {
      void loadStatus();
    }, SANDBOX_STATUS_POLL_INTERVAL_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadStatus();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [conversationId, pollSandbox, setSandboxState]);

  return null;
}
