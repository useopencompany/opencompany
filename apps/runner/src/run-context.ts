import { newRunLeaseId } from "@opencompany/agent-runtime";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getWorkspaceSpendCapStatus, type SpendCapStatus } from "@opencompany/billing";
import { workspaceCreditLedger } from "@opencompany/db/schema";
import {
  createLogger,
  endTimingTrace,
  type LogFields,
  startTimingTrace,
  timeAsync,
} from "@opencompany/observability";
import {
  type BraintrustSpan,
  logBraintrustCurrentSpan,
  traceBraintrustStep,
} from "@opencompany/observability/braintrust";
import { and, eq, sql } from "drizzle-orm";
import { clearActiveRun } from "./active-runs";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { createRunControlGate, type RunControlCheck } from "./run-control";
import type { SandboxHandle } from "./sandbox";
import { parkSandboxWhenIdle } from "./session-lifecycle";
import type { ToolLatencySummary } from "./tool-latency";
import { recordSandboxUsage } from "./usage-recorder";

const logger = createLogger({ service: "opencompany-runner", runtime: "server" });

export type RunContext = {
  sessionId: string;
  env: RunnerEnv;
  db: ReturnType<typeof getDb>;
  trace: ReturnType<typeof startTimingTrace>;
  controller: AbortController;
  leaseId: string;
  leaseOwner: string;
  runLease: { sessionId: string; leaseId: string; leaseOwner: string };
};

export function createRunContext(
  traceName: string,
  input: { sessionId: string; messageId: string; env: RunnerEnv; externalSignal?: AbortSignal },
): RunContext {
  const controller = new AbortController();
  linkExternalAbortSignal(controller, input.externalSignal);
  const leaseId = newRunLeaseId();
  const leaseOwner = input.env.instanceId;
  return {
    sessionId: input.sessionId,
    env: input.env,
    db: getDb(),
    trace: startTimingTrace(traceName, {
      session_id: input.sessionId,
      message_id: input.messageId,
      runner_instance_id: input.env.instanceId,
    }),
    controller,
    leaseId,
    leaseOwner,
    runLease: { sessionId: input.sessionId, leaseId, leaseOwner },
  };
}

export async function observeRunStep<T>(
  ctx: RunContext,
  step: string,
  run: (span: BraintrustSpan | undefined) => Promise<T>,
  metadata?: LogFields,
  options?: Parameters<typeof traceBraintrustStep>[3],
) {
  return traceBraintrustStep(
    step,
    (span) => timeAsync(ctx.trace, step, () => run(span), metadata),
    metadata,
    options,
  );
}

export function createLeaseAbortCheck(ctx: RunContext): RunControlCheck {
  return createRunControlGate({ runLease: ctx.runLease, controller: ctx.controller });
}

/**
 * A daily-spend-cap check for the streaming hot path. Returns the cap status when a cap is
 * configured for the workspace (so the caller can act on `overCap`), or `null` when no cap
 * applies. Once it observes "no cap configured" it caches that and short-circuits to `null`,
 * so the default-off majority pays a single query per turn rather than one per model step.
 * Construct once per run; call at each step boundary (see collectAssistantStream).
 */
export type SpendCapCheck = () => Promise<SpendCapStatus | null>;

export function createSpendCapGate(ctx: RunContext, workspaceId: string): SpendCapCheck {
  let knownUnconfigured = false;
  return async () => {
    if (knownUnconfigured) return null;
    const status = await getWorkspaceSpendCapStatus({ db: ctx.db, workspaceId });
    if (!status.capConfigured) {
      knownUnconfigured = true;
      return null;
    }
    return status;
  };
}

export function linkExternalAbortSignal(
  controller: AbortController,
  signal: AbortSignal | undefined,
) {
  if (!signal) return;
  if (signal.aborted) {
    controller.abort();
    return;
  }
  signal.addEventListener("abort", () => controller.abort(), { once: true });
}

export type SandboxBillingSnapshot = {
  sandboxId: string;
  hydratedAt: Date;
  template: string | null;
  vcpu: number;
  ramMib: number;
};

// Bill the sandbox active-runtime window (hydration → now). MUST be called while the run
// lease is still held — `recordSandboxUsage` is lease-guarded and silently no-ops once the
// lease is released, so finalizeRun (which runs after the lease is gone) is too late. Callers
// invoke this right before releasing/suspending the lease. Best-effort: a lost lease or
// transient DB error must never break the turn, so we log and move on rather than throw.
export async function recordSandboxUsageBestEffort(input: {
  ctx: RunContext;
  assistantMessageId: string;
  sandboxBilling: SandboxBillingSnapshot | null | undefined;
}) {
  if (!input.sandboxBilling) return;
  const billing = input.sandboxBilling;
  const endedAt = new Date();
  const activeMs = Math.max(0, endedAt.getTime() - billing.hydratedAt.getTime());
  try {
    await observeRunStep(
      input.ctx,
      "record_sandbox_usage",
      () =>
        recordSandboxUsage({
          sessionId: input.ctx.sessionId,
          assistantMessageId: input.assistantMessageId,
          runLeaseId: input.ctx.leaseId,
          runLeaseOwner: input.ctx.leaseOwner,
          sandboxId: billing.sandboxId,
          template: billing.template,
          vcpu: billing.vcpu,
          ramMib: billing.ramMib,
          startedAt: billing.hydratedAt,
          endedAt,
          activeMs,
        }),
      { sandbox_id: billing.sandboxId, active_ms: activeMs },
    );
  } catch (error) {
    logger.warn("Failed to record sandbox usage", {
      session_id: input.ctx.sessionId,
      sandbox_id: billing.sandboxId,
      error,
    });
  }
}

export async function finalizeRun(input: {
  ctx: RunContext;
  outcome: string;
  modelProvider: string | undefined;
  modelName: string | undefined;
  sandbox: SandboxHandle | null;
}) {
  clearActiveRun(input.ctx.sessionId, input.ctx.controller);
  logBraintrustCurrentSpan({
    metadata: {
      outcome: input.outcome,
      model_provider: input.modelProvider,
      model_name: input.modelName,
      sandbox_id: input.sandbox?.sandboxId,
      sandbox_hydrated: Boolean(input.sandbox),
    },
  });
  endTimingTrace(input.ctx.trace, {
    outcome: input.outcome,
    model_provider: input.modelProvider,
    model_name: input.modelName,
    sandbox_hydrated: Boolean(input.sandbox),
  });
  if (input.sandbox) {
    const sandbox = input.sandbox;
    await observeRunStep(
      input.ctx,
      "park_sandbox",
      () => parkSandboxWhenIdle(sandbox, input.ctx.env),
      { sandbox_id: sandbox.sandboxId },
    );
  }
}

export async function captureTurnCompletedAnalytics(input: {
  ctx: RunContext;
  userId: string | undefined;
  workspaceId: string | undefined;
  agentId: string | undefined;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  modelProvider: string | undefined;
  modelName: string | undefined;
  toolLatency?: ToolLatencySummary | undefined;
}) {
  if (
    !input.userId ||
    !input.workspaceId ||
    !input.agentId ||
    !input.modelProvider ||
    !input.modelName
  ) {
    return;
  }

  const [cost] = await input.ctx.db
    .select({
      providerCostUsdMicros: sql<number>`COALESCE(SUM(${workspaceCreditLedger.providerCostUsdMicros}), 0)`,
      platformFeeUsdMicros: sql<number>`COALESCE(SUM(${workspaceCreditLedger.platformFeeUsdMicros}), 0)`,
      totalCostUsdMicros: sql<number>`COALESCE(SUM(-${workspaceCreditLedger.amountUsdMicros}), 0)`,
      modelCostUsdMicros: sql<number>`COALESCE(SUM(-${workspaceCreditLedger.amountUsdMicros}) FILTER (WHERE ${workspaceCreditLedger.source} = 'model_usage'), 0)`,
      toolCostUsdMicros: sql<number>`COALESCE(SUM(-${workspaceCreditLedger.amountUsdMicros}) FILTER (WHERE ${workspaceCreditLedger.source} = 'tool_usage'), 0)`,
      sandboxCostUsdMicros: sql<number>`COALESCE(SUM(-${workspaceCreditLedger.amountUsdMicros}) FILTER (WHERE ${workspaceCreditLedger.source} = 'sandbox_usage'), 0)`,
    })
    .from(workspaceCreditLedger)
    .where(
      and(
        eq(workspaceCreditLedger.workspaceId, input.workspaceId),
        eq(workspaceCreditLedger.sessionId, input.sessionId),
        eq(workspaceCreditLedger.messageId, input.assistantMessageId),
      ),
    );

  await captureServerEvent("session_turn_completed", input.userId, {
    user_id: input.userId,
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    session_id: input.sessionId,
    user_message_id: input.userMessageId,
    assistant_message_id: input.assistantMessageId,
    model_provider: input.modelProvider,
    model_name: input.modelName,
    provider_cost_usd_micros: cost?.providerCostUsdMicros ?? 0,
    platform_fee_usd_micros: cost?.platformFeeUsdMicros ?? 0,
    total_cost_usd_micros: cost?.totalCostUsdMicros ?? 0,
    model_cost_usd_micros: cost?.modelCostUsdMicros ?? 0,
    tool_cost_usd_micros: cost?.toolCostUsdMicros ?? 0,
    sandbox_cost_usd_micros: cost?.sandboxCostUsdMicros ?? 0,
    // Latency rollup: run start → now (trace.startedAt is performance.now()-based), plus the
    // per-phase sums collected from every tool call's ToolCallTimings this turn.
    turn_duration_ms: Math.round(performance.now() - input.ctx.trace.startedAt),
    ...(input.toolLatency
      ? {
          tool_call_count: input.toolLatency.toolCallCount,
          tool_failed_count: input.toolLatency.toolFailedCount,
          tool_total_ms: input.toolLatency.toolTotalMs,
          tool_exec_ms: input.toolLatency.toolExecMs,
          tool_sandbox_wait_ms: input.toolLatency.toolSandboxWaitMs,
          tool_gate_wait_ms: input.toolLatency.toolGateWaitMs,
          tool_persist_ms: input.toolLatency.toolPersistMs,
          tool_max_total_ms: input.toolLatency.toolMaxTotalMs,
          ...(input.toolLatency.slowestToolName
            ? { slowest_tool_name: input.toolLatency.slowestToolName }
            : {}),
        }
      : {}),
  });
}

export function braintrustError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}
