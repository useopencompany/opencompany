"use client";

import { useEffect, useRef, useState } from "react";
import type { RuntimeEvent, SessionRuntimeState } from "@/lib/agent-sessions/runtime-events";
import {
  createEmptySessionRuntimeState,
  type SessionStreamStatus,
  subscribeSessionStream,
} from "@/lib/agent-sessions/session-stream";

/**
 * Subscribe the open session's transcript to its Durable Stream. Returns the
 * live-materialized runtime state (rebuilt from the stream via the existing
 * reducer) plus the connection status. Client-only: the stream is
 * read through the same-origin proxy built from `window.location.origin`, so the
 * subscription opens in an effect (never during SSR).
 *
 * `onEvent` fires once per reduced event (durable + transient), for per-event
 * side effects like the felt-TTFT analytics timer; it's ref'd so passing a fresh
 * closure each render doesn't re-open the stream.
 */
export function useSessionStream(
  sessionId: string,
  options?: {
    enabled?: boolean;
    onEvent?: (event: RuntimeEvent) => void;
    // Tail from the stream's current end instead of replaying from "-1" — pass true
    // when there's no in-flight turn (the transcript is already painted from the
    // server snapshot). Captured at subscribe time, so a later status change doesn't
    // re-open the stream. See SessionStreamOptions.seedFromEnd.
    seedFromEnd?: boolean;
  },
): {
  state: SessionRuntimeState;
  status: SessionStreamStatus;
} {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<SessionRuntimeState>(createEmptySessionRuntimeState);
  const [status, setStatus] = useState<SessionStreamStatus>("connecting");

  const onEventRef = useRef(options?.onEvent);
  const seedFromEndRef = useRef(options?.seedFromEnd);
  useEffect(() => {
    onEventRef.current = options?.onEvent;
    seedFromEndRef.current = options?.seedFromEnd;
  });

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
    if (!enabled) return;
    const url = `${window.location.origin}/api/streams/v1/session/${sessionId}`;
    const unsubscribe = subscribeSessionStream(
      url,
      {
        onState: setState,
        onStatus: setStatus,
        onEvent: (event) => onEventRef.current?.(event),
      },
      { seedFromEnd: seedFromEndRef.current },
    );
    return unsubscribe;
  }, [sessionId, enabled]);

  return { state, status };
}
