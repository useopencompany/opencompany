import { stream } from "@durable-streams/client";
import {
  applyRuntimeEventToState,
  emptyCostSummary,
  emptyUsageSummary,
  type RuntimeEvent,
  type SessionRuntimeState,
} from "@/lib/agent-sessions/runtime-events";

/**
 * Framework-agnostic consumer for a session's Durable Stream (Phase 3, plane B —
 * see INSTANT_REFACTOR.md). Catches up the durable + transient history, then live
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

export function createEmptySessionRuntimeState(status = "created"): SessionRuntimeState {
  return {
    events: [],
    messages: [],
    usage: emptyUsageSummary(),
    toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
    cost: emptyCostSummary(),
    currentStatus: status,
    lastError: null,
  };
}

/**
 * Subscribe to a session stream at `url` (the same-origin read proxy). Returns an
 * unsubscribe function.
 *
 * A single SSE read from offset `-1` replays the durable + transient history and
 * then live-tails in one connection — `subscribeJson` delivers catch-up batches
 * followed by live ones, so there is no catch-up→live handoff gap. SSE gives the
 * lowest delivery latency; `@durable-streams/client` reconnects internally and
 * resumes from its tracked offset. We also track the offset for observability and
 * a future manual re-open.
 */
export function subscribeSessionStream(url: string, handlers: SessionStreamHandlers): () => void {
  let state = createEmptySessionRuntimeState();
  let offset = "-1";
  let stopped = false;
  let cancelLive: (() => void) | null = null;

  const reduce = (items: ReadonlyArray<RuntimeEvent>) => {
    if (items.length === 0) return;
    for (const item of items) {
      state = applyRuntimeEventToState(state, item);
      handlers.onEvent?.(item);
    }
    handlers.onState(state);
  };

  void (async () => {
    try {
      handlers.onStatus?.("connecting");
      const live = await stream<RuntimeEvent>({
        url,
        json: true,
        live: "sse",
        offset,
        onError: (error) => handlers.onError?.(error),
      });
      handlers.onStatus?.("live");
      const unsubscribe = live.subscribeJson((batch) => {
        offset = batch.offset;
        reduce(batch.items);
      });
      cancelLive = () => {
        unsubscribe();
        live.cancel();
      };
      if (stopped) cancelLive();
    } catch (error) {
      if (stopped) return;
      handlers.onStatus?.("error");
      handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return () => {
    stopped = true;
    cancelLive?.();
  };
}
