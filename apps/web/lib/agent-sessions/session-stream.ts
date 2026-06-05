import { DurableStream, DurableStreamError, stream } from "@durable-streams/client";
import {
  applyRuntimeEventToState,
  emptyCostSummary,
  emptyUsageSummary,
  type RuntimeEvent,
  type SessionRuntimeState,
} from "@/lib/agent-sessions/runtime-events";

// Auth/shape errors won't fix themselves — give up immediately. Everything else
// (NOT_FOUND on a not-yet-created stream, RATE_LIMITED, BUSY, network/UNKNOWN) is
// transient and worth a backed-off retry.
const TERMINAL_ERROR_CODES = new Set(["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST"]);
const MAX_CONNECT_ATTEMPTS = 8;

function isTerminalStreamError(error: unknown): boolean {
  return error instanceof DurableStreamError && TERMINAL_ERROR_CODES.has(error.code);
}

function streamErrorCode(error: unknown): string {
  return error instanceof DurableStreamError ? error.code : "UNKNOWN";
}

// Trace is always on outside production; in production it's opt-in per-page via
// the `?d=1` URL flag (which survives the refresh we're trying to observe).
// Resolved lazily once so we don't reparse the URL on every batch.
let traceEnabled: boolean | undefined;

function isTraceEnabled(): boolean {
  if (traceEnabled === undefined) {
    if (process.env.NODE_ENV !== "production") {
      traceEnabled = true;
    } else if (typeof window === "undefined") {
      traceEnabled = false; // SSR: no URL to read.
    } else {
      traceEnabled = new URLSearchParams(window.location.search).get("d") === "1";
    }
  }
  return traceEnabled;
}

function debugLog(message: string, fields: Record<string, unknown>): void {
  // Browser-side structured trace for the streaming lifecycle (the channel the
  // user actually reads). console.info so it shows without enabling Verbose.
  if (!isTraceEnabled()) return;
  console.info(`[session-stream] ${message}`, fields);
}

/**
 * Framework-agnostic consumer for a session's Durable Stream (see
 * docs/stack/electric-sync.md). Catches up the durable + transient history, then live
 * tails, folding every event through the existing `applyRuntimeEventToState`
 * reducer to rebuild the rendered transcript. The React hook (`useSessionStream`)
 * wraps this; keeping it framework-free makes the materialization unit-testable
 * against the in-process reference server.
 *
 * Resumability: catch-up replays from offset "-1" (the whole stream), so a refresh
 * mid-generation reconstructs the in-flight assistant text from the streamed token
 * deltas — the property raw SSE can't give. `message.completed` later overrides
 * the accumulated deltas with the final content, so replay stays correct.
 *
 * NOTE (follow-up optimisation): replaying every token delta from "-1" is wasteful
 * on long sessions. A later pass can seed the compact durable snapshot from the
 * server loader and tail the stream from a recent offset instead.
 */

export type SessionStreamStatus = "connecting" | "live" | "error";

type SessionStreamHandlers = {
  onState: (state: SessionRuntimeState) => void;
  onStatus?: (status: SessionStreamStatus) => void;
  onError?: (error: Error) => void;
  // Fired once per reduced event (durable + transient), in stream order. Used for
  // per-event side effects like the felt-TTFT analytics timer.
  onEvent?: (event: RuntimeEvent) => void;
};

type SessionStreamOptions = {
  // When true, tail from the stream's current end (resolved via a HEAD) instead of
  // replaying from offset "-1". Use for sessions with no in-flight turn: the durable
  // transcript is already painted from the Postgres snapshot, so replaying every
  // historical token delta is pure waste. An actively-generating session must still
  // replay from "-1" to reconstruct the in-flight assistant text. Falls back to "-1"
  // if the stream doesn't exist yet (a brand-new session) or the HEAD fails.
  seedFromEnd?: boolean | undefined;
};

export function createEmptySessionRuntimeState(status = "created"): SessionRuntimeState {
  return {
    events: [],
    messages: [],
    usage: emptyUsageSummary(),
    toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
    cost: emptyCostSummary(),
    currentStatus: status,
    lastError: null,
    statusObserved: false,
  };
}

/**
 * Subscribe to a session stream at `url` (the same-origin read proxy). Returns an
 * unsubscribe function.
 *
 * A single SSE read replays the durable + transient history from the start offset and
 * then live-tails in one connection — `subscribeJson` delivers catch-up batches
 * followed by live ones, so there is no catch-up→live handoff gap. SSE gives the
 * lowest delivery latency; `@durable-streams/client` reconnects internally and
 * resumes from its tracked offset, applying exponential backoff (see `backoffOptions`)
 * between attempts. We also track the offset for observability and a future manual
 * re-open.
 *
 * Start offset: "-1" (whole stream) by default, so a refresh mid-generation rebuilds
 * the in-flight assistant text from the streamed deltas. For a session with no active
 * turn, pass `seedFromEnd` to tail from the current end instead (the snapshot already
 * carries the durable transcript) — see `SessionStreamOptions.seedFromEnd`.
 */
export function subscribeSessionStream(
  url: string,
  handlers: SessionStreamHandlers,
  options?: SessionStreamOptions,
): () => void {
  let state = createEmptySessionRuntimeState();
  let offset = "-1";
  let stopped = false;
  let cancelLive: (() => void) | null = null;
  // Consecutive failed (re)connect attempts — reset to 0 on any healthy batch, so the
  // give-up budget tracks a sustained outage, not blips spread across a long session.
  let connectAttempts = 0;

  const reduce = (items: ReadonlyArray<RuntimeEvent>) => {
    if (items.length === 0) return;
    for (const item of items) {
      state = applyRuntimeEventToState(state, item);
      handlers.onEvent?.(item);
    }
    handlers.onState(state);
  };

  // Recoverable-error handler (Electric/Durable-Streams pattern): return `{}` to
  // retry, `undefined` to propagate (terminal). The client already applies the
  // configured exponential backoff before reconnecting, so we don't sleep here — we
  // only decide whether to keep going. Auth/shape errors are terminal; everything
  // else self-heals until the consecutive-failure budget is spent.
  const onError = (error: Error): Record<string, never> | undefined => {
    if (stopped || isTerminalStreamError(error) || connectAttempts >= MAX_CONNECT_ATTEMPTS) {
      return undefined;
    }
    connectAttempts += 1;
    debugLog("connect retry", { url, attempt: connectAttempts, code: streamErrorCode(error) });
    handlers.onStatus?.("connecting");
    return {};
  };

  void (async () => {
    try {
      handlers.onStatus?.("connecting");

      // Seed from the stream's current end when there's no in-flight turn: resolve the
      // tail offset via HEAD and tail from there (no historical-delta replay). Fall back
      // to "-1" when the stream doesn't exist yet or HEAD fails — replaying an empty or
      // full stream is correct, just less efficient.
      if (options?.seedFromEnd) {
        try {
          const head = await DurableStream.head({ url });
          if (head.exists && head.offset) offset = head.offset;
          debugLog("seed-from-end", { url, exists: head.exists, offset });
        } catch (error) {
          debugLog("head failed", { url, code: streamErrorCode(error) });
        }
        if (stopped) return;
      }

      const live = await stream<RuntimeEvent>({
        url,
        json: true,
        live: "sse",
        offset,
        onError,
        // Lean on the client's own exponential backoff instead of a hand-rolled sleep.
        backoffOptions: { initialDelay: 250, maxDelay: 5000, multiplier: 2 },
        // If the SSE connection keeps cutting short (e.g. an intermediary buffering the
        // tail), fall back to long-poll rather than thrashing reconnects.
        sseResilience: { logWarnings: false },
      });
      connectAttempts = 0;
      handlers.onStatus?.("live");
      debugLog("live", { url, offset });
      const unsubscribe = live.subscribeJson((batch) => {
        // A delivered batch means the connection is healthy — reset the failure budget.
        connectAttempts = 0;
        offset = batch.offset;
        debugLog("batch", {
          offset: batch.offset,
          count: batch.items.length,
          upToDate: (batch as { upToDate?: boolean }).upToDate ?? null,
        });
        reduce(batch.items);
      });
      cancelLive = () => {
        unsubscribe();
        live.cancel();
      };
      if (stopped) cancelLive();
    } catch (error) {
      if (stopped) return;
      debugLog("error", { url, code: streamErrorCode(error) });
      handlers.onStatus?.("error");
      handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return () => {
    stopped = true;
    cancelLive?.();
  };
}
