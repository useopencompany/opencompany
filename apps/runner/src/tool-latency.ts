import type { RuntimeToolDefinition, ToolCallTimings } from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";

// Per-call PostHog events would be wasteful at tool-call volume (captureServerEvent creates a
// client + POST per event), so the collector emits two cheaper shapes instead: a per-turn rollup
// merged into session_turn_completed, and an individual tool_call_slow event only for calls that
// cross this threshold — keeping tail latency visible in PostHog with its phase breakdown while
// Braintrust spans / event timings keep the full per-call grain.
const SLOW_TOOL_CALL_EVENT_THRESHOLD_MS = 2_000;

export type ToolTimingRecord = {
  toolName: string;
  toolKind: RuntimeToolDefinition["kind"];
  toolCallId: string;
  failed: boolean;
  timings: ToolCallTimings;
  sandboxId?: string | undefined;
};

export type ToolLatencySummary = {
  toolCallCount: number;
  toolFailedCount: number;
  toolTotalMs: number;
  toolExecMs: number;
  toolSandboxWaitMs: number;
  toolGateWaitMs: number;
  toolPersistMs: number;
  toolMaxTotalMs: number;
  slowestToolName?: string;
};

export type ToolLatencyCollector = {
  record: (record: ToolTimingRecord) => void;
  summary: () => ToolLatencySummary;
};

export function createToolLatencyCollector(input: {
  userId: string | undefined;
  workspaceId: string | undefined;
  agentId: string | undefined;
  sessionId: string;
  assistantMessageId: string;
}): ToolLatencyCollector {
  const summary: ToolLatencySummary = {
    toolCallCount: 0,
    toolFailedCount: 0,
    toolTotalMs: 0,
    toolExecMs: 0,
    toolSandboxWaitMs: 0,
    toolGateWaitMs: 0,
    toolPersistMs: 0,
    toolMaxTotalMs: 0,
  };

  return {
    record(record) {
      const totalMs = record.timings.totalMs ?? 0;
      summary.toolCallCount += 1;
      if (record.failed) summary.toolFailedCount += 1;
      summary.toolTotalMs += totalMs;
      summary.toolExecMs += record.timings.execMs ?? 0;
      summary.toolSandboxWaitMs += record.timings.sandboxWaitMs ?? 0;
      summary.toolGateWaitMs += record.timings.gateWaitMs ?? 0;
      summary.toolPersistMs += record.timings.persistMs ?? 0;
      if (totalMs > summary.toolMaxTotalMs) {
        summary.toolMaxTotalMs = totalMs;
        summary.slowestToolName = record.toolName;
      }

      if (totalMs < SLOW_TOOL_CALL_EVENT_THRESHOLD_MS || !input.userId) return;
      void captureServerEvent("tool_call_slow", input.userId, {
        user_id: input.userId,
        ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
        ...(input.agentId ? { agent_id: input.agentId } : {}),
        session_id: input.sessionId,
        message_id: input.assistantMessageId,
        tool_call_id: record.toolCallId,
        tool_name: record.toolName,
        tool_kind: record.toolKind,
        failed: record.failed,
        total_ms: totalMs,
        exec_ms: record.timings.execMs ?? 0,
        persist_ms: record.timings.persistMs ?? 0,
        ...(record.timings.gateWaitMs !== undefined
          ? { gate_wait_ms: record.timings.gateWaitMs }
          : {}),
        ...(record.timings.sandboxWaitMs !== undefined
          ? { sandbox_wait_ms: record.timings.sandboxWaitMs }
          : {}),
        ...(record.sandboxId ? { sandbox_id: record.sandboxId } : {}),
      }).catch(() => {});
    },
    summary() {
      return { ...summary };
    },
  };
}
