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
 *
 * Death recovery: the client reconnects internally, but a subscription can still
 * die for good — the hidden-tab pause/resume race, an exhausted retry budget, or
 * a silent close (status flips to "error", see subscribeSessionStream). A dead
 * stream must not strand the transcript on its last state (the "frozen thinking
 * spinner" after returning to a backgrounded tab), so when the tab regains
 * visibility/focus or the network comes back while dead, the hook resets the
 * overlay and re-subscribes from "-1" — replaying the full stream rebuilds
 * everything missed, including the turn's completion.
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
  // Bumped to tear down a DEAD subscription and open a fresh one (recovery only —
  // never while the stream is healthy). Recovery replays from "-1" regardless of
  // seedFromEnd: the overlay is reset to empty and the snapshot floor may be stale,
  // so only a full replay is guaranteed to rebuild what the dead stream missed.
  const [generation, setGeneration] = useState(0);

  const onEventRef = useRef(options?.onEvent);
  const seedFromEndRef = useRef(options?.seedFromEnd);
  useEffect(() => {
    onEventRef.current = options?.onEvent;
    seedFromEndRef.current = options?.seedFromEnd;
  });
  // Latest status for the recovery listeners (they must read it without
  // re-registering on every status change).
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Reset to an empty transcript when the session changes, adjusting state during
  // render (the React-endorsed pattern) rather than in the effect — the new
  // stream then replays its history from offset -1.
  const [streamedSessionId, setStreamedSessionId] = useState(sessionId);
  if (sessionId !== streamedSessionId) {
    setStreamedSessionId(sessionId);
    setState(createEmptySessionRuntimeState());
    setStatus("connecting");
    setGeneration(0);
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
      { seedFromEnd: generation === 0 ? seedFromEndRef.current : false },
    );
    return unsubscribe;
  }, [sessionId, enabled, generation]);

  // Recover a dead subscription when the user (or the network) comes back. The
  // primary repro is a backgrounded tab: the client pauses while hidden and its
  // resume can kill the subscription, so on the next visibility/focus/online signal
  // a dead stream is rebuilt from scratch. Gated on status === "error" — a healthy
  // or still-retrying stream is never torn down, so this can't loop or thrash.
  useEffect(() => {
    if (!enabled) return;
    const recoverIfDead = () => {
      if (document.visibilityState !== "visible") return;
      if (statusRef.current !== "error") return;
      setState(createEmptySessionRuntimeState());
      setStatus("connecting");
      setGeneration((current) => current + 1);
    };
    document.addEventListener("visibilitychange", recoverIfDead);
    window.addEventListener("focus", recoverIfDead);
    window.addEventListener("online", recoverIfDead);
    return () => {
      document.removeEventListener("visibilitychange", recoverIfDead);
      window.removeEventListener("focus", recoverIfDead);
      window.removeEventListener("online", recoverIfDead);
    };
  }, [enabled]);

  return { state, status };
}
