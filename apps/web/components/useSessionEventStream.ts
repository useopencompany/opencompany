"use client";

import { useEffect, useRef, useState } from "react";
import type { RuntimeEvent } from "@/lib/agent-sessions/runtime-events";

export type SessionEventStreamStatus = "idle" | "connecting" | "open" | "error" | "stale";

type Input = {
  runnerUrl: string | null;
  streamToken: string | null;
  sessionId: string;
  afterId: number;
  knownEventIds: number[];
  onEvent: (event: RuntimeEvent) => void;
};

export function useSessionEventStream({
  runnerUrl,
  streamToken,
  sessionId,
  afterId,
  knownEventIds,
  onEvent,
}: Input) {
  const [status, setStatus] = useState<SessionEventStreamStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPageVisible, setIsPageVisible] = useState(readPageVisible);
  const [isOnline, setIsOnline] = useState(readOnline);
  const onEventRef = useRef(onEvent);
  const processedEventIds = useRef(new Set(knownEventIds));
  const sourceRef = useRef<EventSource | null>(null);
  const pageVisibleRef = useRef(isPageVisible);
  const onlineRef = useRef(isOnline);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    pageVisibleRef.current = isPageVisible;
  }, [isPageVisible]);

  useEffect(() => {
    onlineRef.current = isOnline;
  }, [isOnline]);

  useEffect(() => {
    for (const id of knownEventIds) {
      processedEventIds.current.add(id);
    }
  }, [knownEventIds]);

  useEffect(() => {
    const handleVisibility = () => {
      setIsPageVisible(readPageVisible());
    };
    const handleOnline = () => {
      setIsOnline(true);
    };
    const handleOffline = () => {
      setIsOnline(false);
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!runnerUrl || !streamToken) {
      return;
    }

    const connectingTimer = window.setTimeout(() => {
      setStatus("connecting");
      setErrorMessage(null);
    }, 0);

    const url = new URL(`${runnerUrl}/sessions/${sessionId}/events`);
    url.searchParams.set("token", streamToken);
    if (afterId > 0) url.searchParams.set("after", String(afterId));

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => {
      setStatus("open");
      setErrorMessage(null);
    };

    source.onmessage = (message) => {
      const event = parseRuntimeEvent(message.data);
      if (!event) {
        setStatus("error");
        setErrorMessage("The live session stream sent an unreadable event.");
        return;
      }
      if (processedEventIds.current.has(event.id)) return;
      processedEventIds.current.add(event.id);
      onEventRef.current(event);
    };

    source.onerror = () => {
      if (!pageVisibleRef.current || !onlineRef.current) {
        setStatus("connecting");
        setErrorMessage(null);
        return;
      }
      setStatus("error");
      setErrorMessage("The live session stream disconnected. Reconnecting automatically.");
    };

    source.addEventListener("session.error", (message) => {
      setStatus("error");
      setErrorMessage(readStreamErrorMessage(message));
    });

    return () => {
      window.clearTimeout(connectingTimer);
      if (sourceRef.current === source) sourceRef.current = null;
      source.close();
    };
    // Connect once per token/session. The initial afterId is encoded in the URL for replay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerUrl, streamToken, sessionId]);

  useEffect(() => {
    if (!isPageVisible || !isOnline) return;
    if (status !== "connecting" && status !== "error") return;
    const timer = window.setTimeout(() => {
      setStatus("stale");
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [isOnline, isPageVisible, status]);

  useEffect(() => {
    if (!runnerUrl || !streamToken || !isPageVisible || !isOnline) return;
    const timer = window.setTimeout(() => {
      if (sourceRef.current?.readyState === EventSource.OPEN) {
        setStatus("open");
        setErrorMessage(null);
        return;
      }
      if (status === "stale" || status === "error") {
        setStatus("connecting");
        setErrorMessage(null);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isOnline, isPageVisible, runnerUrl, status, streamToken]);

  const visibleStatus =
    runnerUrl && streamToken && isPageVisible && isOnline ? status : ("idle" as const);

  return { status: visibleStatus, errorMessage };
}

function parseRuntimeEvent(data: string): RuntimeEvent | null {
  try {
    const value = JSON.parse(data) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "number" || typeof record.type !== "string") return null;
    if (!record.payload || typeof record.payload !== "object") return null;
    return {
      id: record.id,
      type: record.type,
      messageId: typeof record.messageId === "string" ? record.messageId : null,
      payload: record.payload as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function readStreamErrorMessage(message: MessageEvent) {
  if (typeof message.data !== "string") return "The live session stream failed.";
  try {
    const value = JSON.parse(message.data) as unknown;
    if (!value || typeof value !== "object") return "The live session stream failed.";
    const text = (value as Record<string, unknown>).message;
    return typeof text === "string" && text ? text : "The live session stream failed.";
  } catch {
    return "The live session stream failed.";
  }
}

function readPageVisible() {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

function readOnline() {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}
