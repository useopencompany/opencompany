import { calculatePlatformFeeUsdMicros, USD_MICROS_PER_DOLLAR } from "@opencompany/billing";
import { maybeTriggerAutoRefill } from "@opencompany/billing/auto-refill";
import { ensureMonthlyIncludedUsage } from "@opencompany/db/billing";
import {
  consumeCapabilityApprovalByToolCall,
  createCapabilityRun,
  getCapabilitySessionBudgetUsdMicros,
  isWorkspaceCapabilityEnabled,
  markCapabilityRunSettlementFailure,
  markCapabilityRunStarted,
  markCapabilityRunStopping,
  settleCapabilityRun,
  sumCapabilitySessionSpendUsdMicros,
} from "@opencompany/db/capabilities";
import { getCreditBalanceUsdMicros, recordCreditDebit } from "@opencompany/db/credits";
import type { CapabilityRun } from "@opencompany/db/product-schema";
import { METRICS, recordCounter, recordHistogram } from "@opencompany/telemetry";
import {
  type ActionExecuteContext,
  ActionExecutionError,
  ActionInvalidParamsError,
  type CapabilityQuote,
  type CapabilityTurnState,
} from "../actions/types";
import type { ManagedCapabilityActionSpec } from "./catalog";
import { assertManagedCapabilityInspection } from "./contract";
import { hashCapabilityInput } from "./hash";
import {
  isTerminalMonidRun,
  MonidApiError,
  MonidClient,
  type MonidInspection,
  type MonidRun,
} from "./monid";
import { sanitizeCapabilityResult } from "./sanitize";

export const CAPABILITY_APPROVAL_EXPIRES_MS = 15 * 60 * 1_000;
export const CAPABILITY_ASYNC_RUNS_PER_TURN = 6;
export const CAPABILITY_POLL_MAX_MS = 120_000;
export const CAPABILITY_ACTION_TIMEOUT_MS = 125_000;
export const assertInspectionMatches = assertManagedCapabilityInspection;

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const ACTION_QUOTE_TIMEOUT_MS = 20_000;

export function isManagedCapabilitiesKilled() {
  return process.env.OPENCOMPANY_MANAGED_CAPABILITIES_KILL_SWITCH === "true";
}

export function isManagedCapabilityActionKilled(actionId: string) {
  return new Set(
    (process.env.OPENCOMPANY_DISABLED_MANAGED_CAPABILITY_ACTIONS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ).has(actionId);
}

export async function evaluateManagedCapabilityApproval(input: {
  spec: ManagedCapabilityActionSpec;
  params: Record<string, unknown>;
  toolCallId: string;
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  turnState: CapabilityTurnState;
  client?: MonidClient;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<boolean> {
  try {
    if (isManagedCapabilitiesKilled() || isManagedCapabilityActionKilled(input.spec.id)) {
      return false;
    }
    const client = managedCapabilityClient(input.client);
    if (
      !(await isWorkspaceCapabilityEnabled({
        workspaceId: input.workspaceId,
        source: input.spec.source,
      }))
    ) {
      return false;
    }

    const inputHash = hashCapabilityInput({
      action: input.spec.id,
      params: input.params,
    });
    const turnSnapshot = await capabilityTurnSnapshot(input.turnState);
    const cached = turnSnapshot.quotesByToolCallId.get(input.toolCallId);
    if (cached) {
      return cached.inputHash === inputHash && cached.decision === "approval_required";
    }

    const mapped = input.spec.mapInput(input.params);
    const quoteTimeoutSignal = AbortSignal.timeout(ACTION_QUOTE_TIMEOUT_MS);
    const inspection = await client.inspect(
      { provider: input.spec.provider, endpoint: input.spec.endpoint },
      input.signal ? AbortSignal.any([input.signal, quoteTimeoutSignal]) : quoteTimeoutSignal,
    );
    assertInspectionMatches(input.spec, mapped, inspection);
    const quote = capabilityQuote(inputHash, inspection, mapped.resultLimit);
    const [budgetUsdMicros, spentUsdMicros] = await Promise.all([
      getCapabilitySessionBudgetUsdMicros(input.workspaceId),
      sumCapabilitySessionSpendUsdMicros({
        workspaceId: input.workspaceId,
        chatSessionId: input.chatSessionId,
        excludeToolCallIds: turnSnapshot.admittedToolCallIds,
      }),
    ]);
    if (
      spentUsdMicros + turnSnapshot.quotedTotalUsdMicros + quote.quoteTotalCostUsdMicros <=
      budgetUsdMicros
    ) {
      const admitted = await admitCapabilityQuote(
        input.turnState,
        input.toolCallId,
        {
          ...quote,
          decision: "auto",
        },
        budgetUsdMicros - spentUsdMicros,
      );
      if (admitted) return false;
    }

    const createdAt = input.now?.() ?? new Date();
    const run = await createCapabilityRun({
      workspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      chatSessionId: input.chatSessionId,
      toolCallId: input.toolCallId,
      source: input.spec.source,
      action: input.spec.id,
      inputHash,
      provider: input.spec.provider,
      endpoint: input.spec.endpoint,
      status: "awaiting_approval",
      quoteProviderCostUsdMicros: quote.quoteProviderCostUsdMicros,
      quotePlatformFeeUsdMicros: quote.quotePlatformFeeUsdMicros,
      quoteTotalCostUsdMicros: quote.quoteTotalCostUsdMicros,
      approvalExpiresAt: new Date(createdAt.getTime() + CAPABILITY_APPROVAL_EXPIRES_MS),
      now: createdAt,
    });
    await storeCapabilityQuote(
      input.turnState,
      input.toolCallId,
      {
        ...quote,
        decision: "approval_required",
        runId: run.id,
      },
      false,
    );
    return true;
  } catch {
    // AI SDK treats needsApproval failures as stream errors. Execution owns
    // user-visible capability errors, so the gate always falls through.
    return false;
  }
}

export async function executeManagedCapability(input: {
  spec: ManagedCapabilityActionSpec;
  params: Record<string, unknown>;
  context: ActionExecuteContext;
  client?: MonidClient;
  now?: () => Date;
  pollIntervalMs?: number;
}) {
  if (isManagedCapabilitiesKilled()) {
    throw new ActionExecutionError("disabled", "Paid capabilities are temporarily unavailable.");
  }
  if (isManagedCapabilityActionKilled(input.spec.id)) {
    throw new ActionExecutionError(
      "disabled",
      "This paid capability action is temporarily unavailable.",
    );
  }
  const client = managedCapabilityClient(input.client);
  const now = input.now ?? (() => new Date());
  const workspaceId = input.context.workspaceId;
  const chatSessionId = input.context.chatSessionId;
  const turnState = input.context.capabilityTurnState;
  if (!workspaceId || !chatSessionId || !turnState) {
    throw new ActionExecutionError(
      "provider_error",
      "The paid capability execution context is incomplete.",
    );
  }
  if (
    !(await isWorkspaceCapabilityEnabled({
      workspaceId,
      source: input.spec.source,
    }))
  ) {
    throw new ActionExecutionError(
      "disabled",
      "This paid capability is disabled for the workspace.",
    );
  }
  const mapped = input.spec.mapInput(input.params);
  const inputHash = hashCapabilityInput({
    action: input.spec.id,
    params: input.params,
  });
  const toolCallId = input.context.toolCallId ?? "";
  const turnSnapshot = await capabilityTurnSnapshot(turnState);
  const cachedQuote = toolCallId ? turnSnapshot.quotesByToolCallId.get(toolCallId) : undefined;
  if (cachedQuote && cachedQuote.inputHash !== inputHash) {
    throw new ActionExecutionError(
      "provider_error",
      "The paid capability input changed after it was quoted.",
    );
  }
  let quote =
    cachedQuote?.inputHash === inputHash
      ? cachedQuote
      : await inspectCapabilityQuote({
          spec: input.spec,
          mapped,
          inputHash,
          client,
          signal: input.context.signal,
        });

  await ensureMonthlyIncludedUsage(workspaceId);
  const balanceUsdMicros = await getCreditBalanceUsdMicros(workspaceId);
  if (balanceUsdMicros < quote.quoteTotalCostUsdMicros) {
    throw new ActionExecutionError(
      "insufficient_credits",
      "This workspace does not have enough credits for the maximum quoted cost.",
    );
  }

  try {
    await claimAsyncCapabilityRun(input.spec, turnState, toolCallId);
  } catch (error) {
    if (toolCallId && cachedQuote?.decision === "auto") {
      await releaseCapabilityQuote(turnState, toolCallId);
    }
    throw error;
  }

  let auditRun: CapabilityRun;
  if (cachedQuote?.inputHash === inputHash && cachedQuote.decision === "auto") {
    auditRun = await createCapabilityRun({
      workspaceId,
      userWorkosId: input.context.userWorkosId,
      chatSessionId,
      ...(toolCallId ? { toolCallId } : {}),
      source: input.spec.source,
      action: input.spec.id,
      inputHash,
      provider: input.spec.provider,
      endpoint: input.spec.endpoint,
      status: "executing",
      quoteProviderCostUsdMicros: quote.quoteProviderCostUsdMicros,
      quotePlatformFeeUsdMicros: quote.quotePlatformFeeUsdMicros,
      quoteTotalCostUsdMicros: quote.quoteTotalCostUsdMicros,
      now: now(),
    });
  } else {
    const approved = toolCallId
      ? await consumeCapabilityApprovalByToolCall({
          toolCallId,
          userWorkosId: input.context.userWorkosId,
          workspaceId,
          chatSessionId,
          action: input.spec.id,
          inputHash,
          quoteTotalCostUsdMicros: quote.quoteTotalCostUsdMicros,
          now: now(),
        })
      : null;
    if (approved) {
      auditRun = approved;
    } else {
      const [budgetUsdMicros, spentUsdMicros] = await Promise.all([
        getCapabilitySessionBudgetUsdMicros(workspaceId),
        sumCapabilitySessionSpendUsdMicros({
          workspaceId,
          chatSessionId,
          excludeToolCallIds: turnSnapshot.admittedToolCallIds,
        }),
      ]);
      if (
        spentUsdMicros + turnSnapshot.quotedTotalUsdMicros + quote.quoteTotalCostUsdMicros >
        budgetUsdMicros
      ) {
        await releaseAsyncCapabilityRun(input.spec, turnState, toolCallId);
        throw new ActionExecutionError(
          "approval_required",
          "This paid lookup still exceeds the session budget. Ask again only if the user wants a fresh approval card.",
        );
      }
      quote = { ...quote, decision: "auto" };
      if (toolCallId) {
        const admitted = await admitCapabilityQuote(
          turnState,
          toolCallId,
          quote,
          budgetUsdMicros - spentUsdMicros,
        );
        if (!admitted) {
          await releaseAsyncCapabilityRun(input.spec, turnState, toolCallId);
          throw new ActionExecutionError(
            "approval_required",
            "Concurrent paid lookups consumed the remaining session budget. Ask again only if the user wants a fresh approval card.",
          );
        }
      } else {
        turnState.quotedTotalUsdMicros += quote.quoteTotalCostUsdMicros;
      }
      auditRun = await createCapabilityRun({
        workspaceId,
        userWorkosId: input.context.userWorkosId,
        chatSessionId,
        ...(toolCallId ? { toolCallId } : {}),
        source: input.spec.source,
        action: input.spec.id,
        inputHash,
        provider: input.spec.provider,
        endpoint: input.spec.endpoint,
        status: "executing",
        quoteProviderCostUsdMicros: quote.quoteProviderCostUsdMicros,
        quotePlatformFeeUsdMicros: quote.quotePlatformFeeUsdMicros,
        quoteTotalCostUsdMicros: quote.quoteTotalCostUsdMicros,
        now: now(),
      });
    }
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
    await markCapabilityRunStarted({
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
      await markCapabilityRunStopping({
        id: auditRun.id,
        now: now(),
      }).catch(() => undefined);
      await stopRunBestEffort(client, currentRun.runId);
      if (isCapabilityPollTimeout(error)) {
        throw new ActionExecutionError(
          "timeout",
          "The capability is still settling after 120 seconds. Its final cost and status will be reconciled automatically.",
        );
      }
    }
    if (!currentRun && error instanceof MonidApiError) {
      if (error.runId) {
        await markCapabilityRunStarted({
          id: auditRun.id,
          monidRunId: error.runId,
          async: error.async ?? true,
          now: now(),
        });
      } else {
        await settleCapabilityRun({
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
      if (error instanceof ActionInvalidParamsError) {
        await settleManagedCapabilityRun({
          auditRun,
          providerRun: currentRun,
        });
        throw error;
      }
      await settleManagedCapabilityRun({
        auditRun,
        providerRun: currentRun,
        forceFailure: {
          code: "provider_output_invalid",
          message: "The capability returned data that could not be safely used.",
        },
      });
      if (error instanceof ActionExecutionError) throw error;
      throw new ActionExecutionError(
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
    throw new ActionExecutionError("provider_error", settlement.message);
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
    CapabilityRun,
    "id" | "workspaceId" | "userWorkosId" | "chatSessionId" | "source" | "action" | "createdAt"
  >;
  providerRun: MonidRun;
  forceFailure?: {
    code: string;
    message: string;
  };
  db?: any;
}) {
  const providerHttpStatus = input.providerRun.providerResponse?.httpStatus ?? null;
  const success =
    !input.forceFailure &&
    input.providerRun.status === "COMPLETED" &&
    (providerHttpStatus === null || (providerHttpStatus >= 200 && providerHttpStatus < 400));
  const providerCostUsdMicros = providerRunCostUsdMicros(input.providerRun);

  if (providerCostUsdMicros === null) {
    if (input.forceFailure) {
      await markCapabilityRunSettlementFailure({
        id: input.auditRun.id,
        errorCode: input.forceFailure.code,
        errorMessage: input.forceFailure.message,
        db: input.db,
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
    await recordCreditDebit({
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
      db: input.db,
    });
  }

  const status = success
    ? "succeeded"
    : input.providerRun.status === "STOPPED"
      ? "stopped"
      : input.providerRun.status === "TIMED_OUT"
        ? "timed_out"
        : "failed";
  const settledRow = await settleCapabilityRun({
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
    db: input.db,
  });
  if (settledRow) {
    const metricAttributes = {
      "goat.capability_source": input.auditRun.source,
      "goat.capability_action": input.auditRun.action,
      "goat.outcome": status,
    };
    recordCounter(METRICS.capabilityRunsTotal, 1, metricAttributes);
    recordCounter(
      METRICS.capabilityProviderCostUsdMicros,
      settledProviderCostUsdMicros,
      metricAttributes,
    );
    const createdAt = input.auditRun.createdAt;
    if (createdAt instanceof Date && Number.isFinite(createdAt.getTime())) {
      recordHistogram(
        METRICS.capabilitySettlementLagMs,
        Math.max(0, Date.now() - createdAt.getTime()),
        metricAttributes,
      );
    }
  }
  if (totalCostUsdMicros > 0) {
    void maybeTriggerAutoRefill(input.auditRun.workspaceId, { db: input.db });
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
    throw new ActionExecutionError(
      "provider_error",
      "The capability did not return a price quote.",
    );
  }
  const units = inspection.price.type === "PER_RESULT" ? resultLimit : 1;
  return usdToMicros(inspection.price.amount * units) + usdToMicros(inspection.price.flatFee ?? 0);
}

function managedCapabilityClient(client?: MonidClient) {
  if (client) return client;
  const apiKey = process.env.MONID_API_KEY?.trim();
  if (!apiKey) {
    throw new ActionExecutionError("disabled", "Paid capabilities are not configured.");
  }
  return new MonidClient({ apiKey });
}

function capabilityQuote(
  inputHash: string,
  inspection: MonidInspection,
  resultLimit: number,
): Omit<CapabilityQuote, "decision" | "runId"> {
  const quoteProviderCostUsdMicros = calculateMaximumProviderQuoteUsdMicros(
    inspection,
    resultLimit,
  );
  const quotePlatformFeeUsdMicros = calculatePlatformFeeUsdMicros(quoteProviderCostUsdMicros);
  return {
    inputHash,
    quoteProviderCostUsdMicros,
    quotePlatformFeeUsdMicros,
    quoteTotalCostUsdMicros: quoteProviderCostUsdMicros + quotePlatformFeeUsdMicros,
  };
}

async function inspectCapabilityQuote(input: {
  spec: ManagedCapabilityActionSpec;
  mapped: ReturnType<ManagedCapabilityActionSpec["mapInput"]>;
  inputHash: string;
  client: MonidClient;
  signal: AbortSignal;
}) {
  const inspection = await input.client.inspect(
    { provider: input.spec.provider, endpoint: input.spec.endpoint },
    input.signal,
  );
  assertInspectionMatches(input.spec, input.mapped, inspection);
  return {
    ...capabilityQuote(input.inputHash, inspection, input.mapped.resultLimit),
    decision: "auto" as const,
  };
}

async function capabilityTurnSnapshot(turnState: CapabilityTurnState) {
  return turnState.governance?.load() ?? turnState;
}

async function storeCapabilityQuote(
  turnState: CapabilityTurnState,
  toolCallId: string,
  quote: CapabilityQuote,
  admitted: boolean,
  maxQuotedTotalUsdMicros?: number,
) {
  if (turnState.governance) {
    return turnState.governance.storeQuote({
      toolCallId,
      quote,
      admitted,
      ...(maxQuotedTotalUsdMicros === undefined ? {} : { maxQuotedTotalUsdMicros }),
    });
  }
  if (turnState.quotesByToolCallId.has(toolCallId)) return true;
  if (admitted) {
    if (
      maxQuotedTotalUsdMicros !== undefined &&
      turnState.quotedTotalUsdMicros + quote.quoteTotalCostUsdMicros > maxQuotedTotalUsdMicros
    ) {
      return false;
    }
    turnState.quotedTotalUsdMicros += quote.quoteTotalCostUsdMicros;
    turnState.admittedToolCallIds.push(toolCallId);
  }
  turnState.quotesByToolCallId.set(toolCallId, quote);
  return true;
}

async function admitCapabilityQuote(
  turnState: CapabilityTurnState,
  toolCallId: string,
  quote: CapabilityQuote,
  maxQuotedTotalUsdMicros?: number,
) {
  return storeCapabilityQuote(turnState, toolCallId, quote, true, maxQuotedTotalUsdMicros);
}

async function releaseCapabilityQuote(turnState: CapabilityTurnState, toolCallId: string) {
  const quote = (await capabilityTurnSnapshot(turnState)).quotesByToolCallId.get(toolCallId);
  if (!quote) return;
  if (turnState.governance) {
    await turnState.governance.releaseQuote({
      toolCallId,
      quoteTotalCostUsdMicros: quote.quoteTotalCostUsdMicros,
    });
    return;
  }
  turnState.quotesByToolCallId.delete(toolCallId);
  turnState.admittedToolCallIds = turnState.admittedToolCallIds.filter((id) => id !== toolCallId);
  turnState.quotedTotalUsdMicros = Math.max(
    0,
    turnState.quotedTotalUsdMicros - quote.quoteTotalCostUsdMicros,
  );
}

async function claimAsyncCapabilityRun(
  spec: ManagedCapabilityActionSpec,
  turnState: CapabilityTurnState,
  toolCallId: string,
) {
  if (spec.executionMode !== "async") return;
  if (turnState.governance && toolCallId) {
    const claimed = await turnState.governance.claimAsyncRun({
      toolCallId,
      maxRuns: CAPABILITY_ASYNC_RUNS_PER_TURN,
    });
    if (!claimed) {
      throw new ActionExecutionError(
        "call_budget",
        `Only ${CAPABILITY_ASYNC_RUNS_PER_TURN} long-running paid capabilities can be started in a turn.`,
      );
    }
    return;
  }
  if (turnState.asyncRunsStarted >= CAPABILITY_ASYNC_RUNS_PER_TURN) {
    throw new ActionExecutionError(
      "call_budget",
      `Only ${CAPABILITY_ASYNC_RUNS_PER_TURN} long-running paid capabilities can be started in a turn.`,
    );
  }
  // Claim before the next await so parallel calls cannot exceed the limit.
  turnState.asyncRunsStarted += 1;
}

async function releaseAsyncCapabilityRun(
  spec: ManagedCapabilityActionSpec,
  turnState: CapabilityTurnState,
  toolCallId: string,
) {
  if (spec.executionMode !== "async") return;
  if (turnState.governance && toolCallId) {
    await turnState.governance.releaseAsyncRun({ toolCallId });
    return;
  }
  turnState.asyncRunsStarted = Math.max(0, turnState.asyncRunsStarted - 1);
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
    throw new ActionExecutionError(
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
  const deadline = input.now().getTime() + CAPABILITY_POLL_MAX_MS;
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
    throw new ActionExecutionError("provider_error", "The capability returned an invalid price.");
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
