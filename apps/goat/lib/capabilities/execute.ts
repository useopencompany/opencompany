import "server-only";

import { calculatePlatformFeeUsdMicros, USD_MICROS_PER_DOLLAR } from "@opencompany/billing";
import {
  consumeGoatCapabilityApproval,
  createGoatCapabilityRun,
  isGoatWorkspaceCapabilityEnabled,
  markGoatCapabilityRunSettlementFailure,
  markGoatCapabilityRunStarted,
  markGoatCapabilityRunStopping,
  settleGoatCapabilityRun,
} from "@opencompany/db/goat-capabilities";
import { getGoatCreditBalanceUsdMicros, recordGoatCreditDebit } from "@opencompany/db/goat-credits";
import type { GoatCapabilityRun } from "@opencompany/db/goat-schema";
import {
  GOAT_METRICS,
  recordGoatCounter,
  recordGoatHistogram,
} from "@opencompany/goat-observability";
import {
  GoatActionApprovalRequiredError,
  type GoatActionExecuteContext,
  GoatActionExecutionError,
} from "@/lib/actions/types";
import { maybeTriggerGoatAutoRefill } from "@/lib/billing/auto-refill";
import type { ManagedCapabilityActionSpec } from "@/lib/capabilities/catalog";
import { assertManagedCapabilityInspection } from "@/lib/capabilities/contract";
import { hashCapabilityInput } from "@/lib/capabilities/hash";
import {
  isTerminalMonidRun,
  MonidApiError,
  MonidClient,
  type MonidInspection,
  type MonidRun,
} from "@/lib/capabilities/monid";
import { sanitizeCapabilityResult } from "@/lib/capabilities/sanitize";

export const GOAT_CAPABILITY_APPROVAL_EXPIRES_MS = 15 * 60 * 1_000;
export const GOAT_CAPABILITY_AUTO_ACTION_MAX_USD_MICROS = 100_000;
export const GOAT_CAPABILITY_AUTO_TURN_MAX_USD_MICROS = 500_000;
export const GOAT_CAPABILITY_POLL_MAX_MS = 120_000;
export const GOAT_CAPABILITY_ACTION_TIMEOUT_MS = 125_000;
export const assertInspectionMatches = assertManagedCapabilityInspection;

const DEFAULT_POLL_INTERVAL_MS = 1_500;

export function isGoatManagedCapabilitiesKilled() {
  return process.env.GOAT_MANAGED_CAPABILITIES_KILL_SWITCH === "true";
}

export function isGoatManagedCapabilityActionKilled(actionId: string) {
  return new Set(
    (process.env.GOAT_DISABLED_MANAGED_CAPABILITY_ACTIONS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ).has(actionId);
}

export async function executeManagedCapability(input: {
  spec: ManagedCapabilityActionSpec;
  params: Record<string, unknown>;
  context: GoatActionExecuteContext;
  client?: MonidClient;
  now?: () => Date;
  pollIntervalMs?: number;
}) {
  if (isGoatManagedCapabilitiesKilled()) {
    throw new GoatActionExecutionError(
      "disabled",
      "Paid capabilities are temporarily unavailable.",
    );
  }
  if (isGoatManagedCapabilityActionKilled(input.spec.id)) {
    throw new GoatActionExecutionError(
      "disabled",
      "This paid capability action is temporarily unavailable.",
    );
  }
  const apiKey = process.env.MONID_API_KEY?.trim();
  const client =
    input.client ??
    new MonidClient({
      apiKey:
        apiKey ??
        (() => {
          throw new GoatActionExecutionError("disabled", "Paid capabilities are not configured.");
        })(),
    });
  const now = input.now ?? (() => new Date());
  const workspaceId = input.context.workspaceId;
  const chatSessionId = input.context.chatSessionId;
  const turnState = input.context.capabilityTurnState;
  if (!workspaceId || !chatSessionId || !turnState) {
    throw new GoatActionExecutionError(
      "provider_error",
      "The paid capability execution context is incomplete.",
    );
  }
  if (
    !(await isGoatWorkspaceCapabilityEnabled({
      workspaceId,
      source: input.spec.source,
    }))
  ) {
    throw new GoatActionExecutionError(
      "disabled",
      "This paid capability is disabled for the workspace.",
    );
  }
  const mapped = input.spec.mapInput(input.params);
  const inputHash = hashCapabilityInput({
    action: input.spec.id,
    params: input.params,
  });

  const inspection = await client.inspect(
    { provider: input.spec.provider, endpoint: input.spec.endpoint },
    input.context.signal,
  );
  assertInspectionMatches(input.spec, mapped, inspection);
  const quoteProviderCostUsdMicros = calculateMaximumProviderQuoteUsdMicros(
    inspection,
    mapped.resultLimit,
  );
  const quotePlatformFeeUsdMicros = calculatePlatformFeeUsdMicros(quoteProviderCostUsdMicros);
  const quoteTotalCostUsdMicros = quoteProviderCostUsdMicros + quotePlatformFeeUsdMicros;

  const balanceUsdMicros = await getGoatCreditBalanceUsdMicros(workspaceId);
  if (balanceUsdMicros < quoteTotalCostUsdMicros) {
    throw new GoatActionExecutionError(
      "insufficient_credits",
      "This workspace does not have enough credits for the maximum quoted cost.",
    );
  }

  turnState.quotedTotalUsdMicros += quoteTotalCostUsdMicros;
  const requiresApproval =
    quoteTotalCostUsdMicros > GOAT_CAPABILITY_AUTO_ACTION_MAX_USD_MICROS ||
    turnState.quotedTotalUsdMicros > GOAT_CAPABILITY_AUTO_TURN_MAX_USD_MICROS;

  const willExecute = Boolean(input.context.capabilityApprovalRunId) || !requiresApproval;
  if (input.spec.executionMode === "async" && willExecute) {
    if (turnState.asyncRunStarted) {
      throw new GoatActionExecutionError(
        "call_budget",
        "Only one long-running paid capability can be started in a turn.",
      );
    }
    // Claim synchronously before the next await so parallel tool calls cannot
    // both pass the per-turn long-run gate.
    turnState.asyncRunStarted = true;
  }

  let auditRun: GoatCapabilityRun;
  if (input.context.capabilityApprovalRunId) {
    const approved = await consumeGoatCapabilityApproval({
      id: input.context.capabilityApprovalRunId,
      userWorkosId: input.context.userWorkosId,
      workspaceId,
      chatSessionId,
      action: input.spec.id,
      inputHash,
      quoteTotalCostUsdMicros,
      now: now(),
    });
    if (!approved) {
      throw new GoatActionExecutionError(
        "provider_error",
        "This approval is expired, already used, belongs to another request, or no longer covers the current quote.",
      );
    }
    auditRun = approved;
  } else if (requiresApproval) {
    const createdAt = now();
    auditRun = await createGoatCapabilityRun({
      workspaceId,
      userWorkosId: input.context.userWorkosId,
      chatSessionId,
      ...(input.context.toolCallId ? { toolCallId: input.context.toolCallId } : {}),
      source: input.spec.source,
      action: input.spec.id,
      inputHash,
      provider: input.spec.provider,
      endpoint: input.spec.endpoint,
      status: "awaiting_approval",
      quoteProviderCostUsdMicros,
      quotePlatformFeeUsdMicros,
      quoteTotalCostUsdMicros,
      approvalExpiresAt: new Date(createdAt.getTime() + GOAT_CAPABILITY_APPROVAL_EXPIRES_MS),
      now: createdAt,
    });
    throw new GoatActionApprovalRequiredError({
      runId: auditRun.id,
      source: input.spec.source,
      action: input.spec.id,
      maxCostUsdMicros: quoteTotalCostUsdMicros,
      expiresAt: auditRun.approvalExpiresAt!.toISOString(),
      status: "awaiting_approval",
    });
  } else {
    auditRun = await createGoatCapabilityRun({
      workspaceId,
      userWorkosId: input.context.userWorkosId,
      chatSessionId,
      ...(input.context.toolCallId ? { toolCallId: input.context.toolCallId } : {}),
      source: input.spec.source,
      action: input.spec.id,
      inputHash,
      provider: input.spec.provider,
      endpoint: input.spec.endpoint,
      status: "executing",
      quoteProviderCostUsdMicros,
      quotePlatformFeeUsdMicros,
      quoteTotalCostUsdMicros,
      now: now(),
    });
  }

  let currentRun: MonidRun | null = null;
  try {
    const started = await client.run(
      {
        provider: input.spec.provider,
        endpoint: input.spec.endpoint,
        input: input.spec.inputLocation
          ? { [input.spec.inputLocation]: mapped.providerInput }
          : mapped.providerInput,
      },
      input.context.signal,
    );
    currentRun = started.run;
    await markGoatCapabilityRunStarted({
      id: auditRun.id,
      monidRunId: currentRun.runId,
      async: started.async,
      now: now(),
    });
    assertProviderRunMatches(input.spec, currentRun);
    // Monid can use a 202 job envelope for reviewed, short-lived actions that
    // are cataloged as synchronous. The reviewed execution mode — not the
    // transport envelope — owns the per-turn long-running action budget.
    if (!isTerminalMonidRun(currentRun.status)) {
      currentRun = await pollMonidRun({
        client,
        runId: currentRun.runId,
        signal: input.context.signal,
        now,
        intervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      });
      assertProviderRunMatches(input.spec, currentRun);
    }
  } catch (error) {
    if (currentRun && !providerRunMatches(input.spec, currentRun)) {
      if (!isTerminalMonidRun(currentRun.status)) {
        await stopRunBestEffort(client, currentRun.runId);
      }
      await settleManagedCapabilityRun({
        auditRun,
        providerRun: currentRun,
        forceFailure: {
          code: "provider_contract_mismatch",
          message: "The paid capability returned a run for a different reviewed endpoint.",
        },
      }).catch(() => undefined);
    }
    if (currentRun && (input.context.signal.aborted || isCapabilityPollTimeout(error))) {
      await markGoatCapabilityRunStopping({
        id: auditRun.id,
        now: now(),
      }).catch(() => undefined);
      await stopRunBestEffort(client, currentRun.runId);
      if (isCapabilityPollTimeout(error)) {
        throw new GoatActionExecutionError(
          "timeout",
          "The capability is still settling after 120 seconds. Its final cost and status will be reconciled automatically.",
        );
      }
    }
    if (!currentRun && error instanceof MonidApiError) {
      if (error.runId) {
        await markGoatCapabilityRunStarted({
          id: auditRun.id,
          monidRunId: error.runId,
          async: error.async ?? true,
          now: now(),
        });
      } else {
        await settleGoatCapabilityRun({
          id: auditRun.id,
          status: "failed",
          providerCostUsdMicros: 0,
          platformFeeUsdMicros: 0,
          totalCostUsdMicros: 0,
          errorCode: `monid_http_${error.status}`,
          errorMessage: "The paid capability could not be started.",
          now: now(),
        }).catch(() => undefined);
      }
    }
    throw error;
  }

  let payload = currentRun.output;
  if (input.spec.mapOutput) {
    try {
      payload = input.spec.mapOutput(currentRun.output, input.params);
    } catch (error) {
      await settleManagedCapabilityRun({
        auditRun,
        providerRun: currentRun,
        forceFailure: {
          code: "provider_output_invalid",
          message: "The capability returned data that could not be safely used.",
        },
      });
      if (error instanceof GoatActionExecutionError) throw error;
      throw new GoatActionExecutionError(
        "provider_error",
        "The capability returned data that could not be safely used.",
      );
    }
  }
  const settlement = await settleManagedCapabilityRun({
    auditRun,
    providerRun: currentRun,
  });
  if (!settlement.success) {
    throw new GoatActionExecutionError("provider_error", settlement.message);
  }
  return sanitizeCapabilityResult({
    source: input.spec.source,
    action: input.spec.id,
    payload,
    expectedLimit: mapped.resultLimit,
    ...(mapped.payloadArrayLimit === undefined
      ? {}
      : { payloadArrayLimit: mapped.payloadArrayLimit }),
    ...(mapped.payloadStringLimit === undefined
      ? {}
      : { payloadStringLimit: mapped.payloadStringLimit }),
    ...(mapped.discoverPayloadLinks === undefined
      ? {}
      : { discoverPayloadLinks: mapped.discoverPayloadLinks }),
    canonicalLinks: mapped.canonicalLinks,
    ...(currentRun.resultCount === undefined ? {} : { resultCount: currentRun.resultCount }),
    totalCostUsdMicros: settlement.totalCostUsdMicros,
  });
}

export async function settleManagedCapabilityRun(input: {
  auditRun: Pick<
    GoatCapabilityRun,
    "id" | "workspaceId" | "userWorkosId" | "chatSessionId" | "source" | "action" | "createdAt"
  >;
  providerRun: MonidRun;
  forceFailure?: {
    code: string;
    message: string;
  };
}) {
  const providerHttpStatus = input.providerRun.providerResponse?.httpStatus ?? null;
  const success =
    !input.forceFailure &&
    input.providerRun.status === "COMPLETED" &&
    (providerHttpStatus === null || (providerHttpStatus >= 200 && providerHttpStatus < 400));
  const providerCostUsdMicros = providerRunCostUsdMicros(input.providerRun);

  if (providerCostUsdMicros === null) {
    if (input.forceFailure) {
      await markGoatCapabilityRunSettlementFailure({
        id: input.auditRun.id,
        errorCode: input.forceFailure.code,
        errorMessage: input.forceFailure.message,
      });
    }
    return {
      success,
      totalCostUsdMicros: null,
      message: success
        ? "Capability completed; cost is settling."
        : "The capability did not complete and its final cost is settling.",
    };
  }

  const settledProviderCostUsdMicros = providerCostUsdMicros;
  const platformFeeUsdMicros = calculatePlatformFeeUsdMicros(settledProviderCostUsdMicros);
  const totalCostUsdMicros = settledProviderCostUsdMicros + platformFeeUsdMicros;
  if (totalCostUsdMicros > 0) {
    await recordGoatCreditDebit({
      workspaceId: input.auditRun.workspaceId,
      userWorkosId: input.auditRun.userWorkosId,
      source: "capability_usage",
      idempotencyKey: `capability:${input.providerRun.runId}`,
      providerCostUsdMicros: settledProviderCostUsdMicros,
      platformFeeUsdMicros,
      totalCostUsdMicros,
      chatSessionId: input.auditRun.chatSessionId,
      costBasis: {
        kind: "paid_capability",
        priceType: input.providerRun.price?.type ?? "settled",
        billedUnits: input.providerRun.billedUnits ?? input.providerRun.resultCount ?? null,
      },
      metadata: {
        capabilitySource: input.auditRun.source,
        capabilityAction: input.auditRun.action,
        capabilityRunId: input.auditRun.id,
      },
    });
  }

  const status = success
    ? "succeeded"
    : input.providerRun.status === "STOPPED"
      ? "stopped"
      : input.providerRun.status === "TIMED_OUT"
        ? "timed_out"
        : "failed";
  const settledRow = await settleGoatCapabilityRun({
    id: input.auditRun.id,
    status,
    providerHttpStatus,
    resultCount: input.providerRun.resultCount ?? null,
    providerCostUsdMicros: settledProviderCostUsdMicros,
    platformFeeUsdMicros,
    totalCostUsdMicros,
    errorCode: success
      ? null
      : (input.forceFailure?.code ?? providerRunErrorCode(input.providerRun)),
    errorMessage: success
      ? null
      : (input.forceFailure?.message ??
        "The paid capability provider did not complete the request."),
  });
  if (settledRow) {
    const metricAttributes = {
      "goat.capability_source": input.auditRun.source,
      "goat.capability_action": input.auditRun.action,
      "goat.outcome": status,
    };
    recordGoatCounter(GOAT_METRICS.capabilityRunsTotal, 1, metricAttributes);
    recordGoatCounter(
      GOAT_METRICS.capabilityProviderCostUsdMicros,
      settledProviderCostUsdMicros,
      metricAttributes,
    );
    const createdAt = input.auditRun.createdAt;
    if (createdAt instanceof Date && Number.isFinite(createdAt.getTime())) {
      recordGoatHistogram(
        GOAT_METRICS.capabilitySettlementLagMs,
        Math.max(0, Date.now() - createdAt.getTime()),
        metricAttributes,
      );
    }
  }
  if (totalCostUsdMicros > 0) {
    void maybeTriggerGoatAutoRefill(input.auditRun.workspaceId);
  }
  return {
    success,
    totalCostUsdMicros,
    message: success
      ? "Capability completed."
      : (input.forceFailure?.message ??
        "The paid capability provider did not complete the request."),
  };
}

export function calculateMaximumProviderQuoteUsdMicros(
  inspection: MonidInspection,
  resultLimit: number,
) {
  if (!inspection.price) {
    throw new GoatActionExecutionError(
      "provider_error",
      "The capability did not return a price quote.",
    );
  }
  const units = inspection.price.type === "PER_RESULT" ? resultLimit : 1;
  return usdToMicros(inspection.price.amount * units) + usdToMicros(inspection.price.flatFee ?? 0);
}

export function providerRunCostUsdMicros(run: MonidRun): number | null {
  if (run.cost) return usdToMicros(run.cost.value);
  for (const value of [
    run.billing?.reportedCost,
    run.billing?.calculatedCost,
    run.billing?.actualCost,
  ]) {
    if (!value || typeof value.value !== "number" || !Number.isFinite(value.value)) {
      continue;
    }
    if (value.currency !== "USD") continue;
    const unit = value.unit.toUpperCase();
    if (unit === "MICRO_DOLLAR" || unit === "USD_MICRO") return Math.round(value.value);
    if (unit === "CENT" || unit === "CENTS") return Math.round(value.value * 10_000);
    if (unit === "DOLLAR" || unit === "DOLLARS" || unit === "USD") {
      return usdToMicros(value.value);
    }
  }
  return null;
}

function providerRunMatches(spec: ManagedCapabilityActionSpec, run: MonidRun) {
  return run.provider === spec.provider && run.endpoint === spec.endpoint;
}

function assertProviderRunMatches(spec: ManagedCapabilityActionSpec, run: MonidRun) {
  if (!providerRunMatches(spec, run)) {
    throw new GoatActionExecutionError(
      "provider_error",
      "The paid capability returned a run for a different reviewed endpoint.",
    );
  }
}

async function pollMonidRun(input: {
  client: MonidClient;
  runId: string;
  signal: AbortSignal;
  now: () => Date;
  intervalMs: number;
}) {
  const deadline = input.now().getTime() + GOAT_CAPABILITY_POLL_MAX_MS;
  let run = await input.client.getRun(input.runId, input.signal);
  while (!isTerminalMonidRun(run.status)) {
    if (input.now().getTime() >= deadline) throw new CapabilityPollTimeoutError();
    await abortableDelay(input.intervalMs, input.signal);
    run = await input.client.getRun(input.runId, input.signal);
  }
  return run;
}

async function stopRunBestEffort(client: MonidClient, runId: string) {
  try {
    await client.stopRun(runId, AbortSignal.timeout(5_000));
  } catch {
    // The durable running row remains eligible for hourly reconciliation.
  }
}

function usdToMicros(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new GoatActionExecutionError(
      "provider_error",
      "The capability returned an invalid price.",
    );
  }
  return Math.round(value * USD_MICROS_PER_DOLLAR);
}

function providerRunErrorCode(run: MonidRun) {
  if (run.status === "STOPPED") return "stopped";
  if (run.status === "TIMED_OUT") return "timed_out";
  if (run.providerResponse?.httpStatus) {
    return `provider_http_${run.providerResponse.httpStatus}`;
  }
  return run.status.toLowerCase();
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, Math.max(1, ms));
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

class CapabilityPollTimeoutError extends Error {}

function isCapabilityPollTimeout(error: unknown): error is CapabilityPollTimeoutError {
  return error instanceof CapabilityPollTimeoutError;
}
