"use client";

import { useEffect, useState } from "react";
import type { SessionRuntimeState } from "@/lib/agent-sessions/runtime-events";
import {
  createEmptySessionRuntimeState,
  type SessionStreamStatus,
  subscribeSessionStream,
} from "@/lib/agent-sessions/session-stream";

/**
 * Subscribe the open session's transcript to its Durable Stream (Phase 3, plane
 * B). Returns the live-materialized runtime state (rebuilt from the stream via
 * the existing reducer) plus the connection status. Client-only: the stream is
 * read through the same-origin proxy built from `window.location.origin`, so the
 * subscription opens in an effect (never during SSR).
 *
 * Replaces `useSessionEventStream` (raw EventSource SSE + React-Query cache
 * mutation) once SessionView is cut over.
 */
export function useSessionStream(sessionId: string): {
  state: SessionRuntimeState;
  status: SessionStreamStatus;
} {
  const [state, setState] = useState<SessionRuntimeState>(createEmptySessionRuntimeState);
  const [status, setStatus] = useState<SessionStreamStatus>("connecting");

  // Reset to an empty transcript when the session changes, adjusting state during
  // render (the React-endorsed pattern) rather than in the effect — the new
  // stream then replays its history from offset -1.
  const [streamedSessionId, setStreamedSessionId] = useState(sessionId);
  if (sessionId !== streamedSessionId) {
    setStreamedSessionId(sessionId);
    setState(createEmptySessionRuntimeState());
    setStatus("connecting");
  }

  useEffect(() => {
    const url = `${window.location.origin}/api/streams/v1/session/${sessionId}`;
    const unsubscribe = subscribeSessionStream(url, {
      onState: setState,
      onStatus: setStatus,
    });
    return unsubscribe;
  }, [sessionId]);

  return { state, status };
}
