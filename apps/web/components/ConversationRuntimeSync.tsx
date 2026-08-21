"use client";

import type { EngineRuntimeStatus } from "@opencompany/protocol";
import { useLiveQuery } from "@tanstack/react-db";
import { type Dispatch, type SetStateAction, useEffect, useMemo } from "react";
import { useHydrated } from "@/components/useHydrated";
import type { ConversationRuntimeView } from "@/lib/chat-ui";
import {
  getHeadlessChatEngineSession,
  type HeadlessChatEngineSessionReadModel,
} from "@/lib/headless-chat-collections";
import { getEngineRuntimeStatus } from "@/lib/headless-chat-commands";

const SANDBOX_STATUS_POLL_INTERVAL_MS = 30_000;

export function ConversationRuntimeSync({
  conversationId,
  setSandboxStatus,
  setRuntime,
  pollSandbox,
}: {
  conversationId: string;
  setSandboxStatus: Dispatch<SetStateAction<EngineRuntimeStatus | null>>;
  setRuntime: Dispatch<SetStateAction<ConversationRuntimeView | null>>;
  pollSandbox: boolean;
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return (
    <ConversationRuntimeSubscriber
      conversationId={conversationId}
      setSandboxStatus={setSandboxStatus}
      setRuntime={setRuntime}
      pollSandbox={pollSandbox}
    />
  );
}

function ConversationRuntimeSubscriber({
  conversationId,
  setSandboxStatus,
  setRuntime,
  pollSandbox,
}: {
  conversationId: string;
  setSandboxStatus: Dispatch<SetStateAction<EngineRuntimeStatus | null>>;
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
  const status = row?.status ?? null;
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
    if (!pollSandbox || !status) {
      setSandboxStatus(null);
      return;
    }

    const controller = new AbortController();
    let active = true;

    const loadStatus = async () => {
      try {
        const runtimeStatus = await getEngineRuntimeStatus(conversationId, {
          fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }),
        });
        if (!active) return;
        setSandboxStatus(runtimeStatus);
      } catch {
        // Logical runtime still owns turn status when sandbox lifecycle polling is unavailable.
        if (active && (status === "starting" || status === "running")) {
          setSandboxStatus("running");
        }
      }
    };

    void loadStatus();
    const interval = setInterval(() => {
      void loadStatus();
    }, SANDBOX_STATUS_POLL_INTERVAL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [conversationId, pollSandbox, setSandboxStatus, status]);

  return null;
}
