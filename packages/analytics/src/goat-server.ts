import type {
  GoatAnalyticsEngine,
  GoatAnalyticsEventName,
  GoatAnalyticsEventProperties,
  GoatAnalyticsUsageSource,
  GoatTaskSpawnKind,
  GoatTaskSpawnOrigin,
  GoatTaskSpawnTrigger,
} from "./goat-events";
import { type GoatAnalyticsPerson, goatAnalyticsPersonProperties } from "./goat-person";
import { capturePostHogServerEvent } from "./server-core";

type GoatModelSpendBillingSource =
  GoatAnalyticsEventProperties<"model_spend_recorded">["billing_source"];
type GoatModelSpendEngine = GoatAnalyticsEventProperties<"model_spend_recorded">["engine"];
type GoatModelSpendSurface = GoatAnalyticsEventProperties<"model_spend_recorded">["surface"];

export type CaptureGoatTaskSpawnedInput = {
  userWorkosId: string;
  workspaceId?: string | null | undefined;
  taskId: string;
  displayId?: string | null | undefined;
  engine: GoatAnalyticsEngine;
  model: string;
  workflowId?: string | null | undefined;
  scheduleId?: string | null | undefined;
  trigger?: GoatTaskSpawnTrigger | undefined;
};

export type GoatLlmUsageAnalyticsSurface = "chat" | "task";

export type GoatLlmUsageAnalyticsStage =
  | "generation"
  | "routing"
  | "planner"
  | "execution"
  | "closer";

function getGoatPostHogConfig() {
  return {
    token: process.env.NEXT_PUBLIC_POSTHOG_TOKEN,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    project: "goat" as const,
  };
}

export function captureGoatServerEvent<EventName extends GoatAnalyticsEventName>(
  event: EventName,
  distinctId: string,
  properties: GoatAnalyticsEventProperties<EventName>,
  person?: GoatAnalyticsPerson,
) {
  const personProperties = person ? goatAnalyticsPersonProperties(person) : undefined;

  return capturePostHogServerEvent(getGoatPostHogConfig(), {
    event,
    distinctId,
    properties: {
      ...properties,
      ...(personProperties && Object.keys(personProperties).length > 0
        ? { $set: personProperties }
        : {}),
    },
  });
}

export function captureGoatTaskSpawned(input: CaptureGoatTaskSpawnedInput) {
  const workflowId = normalizedOptional(input.workflowId);
  const scheduleId = normalizedOptional(input.scheduleId);
  const workspaceId = normalizedOptional(input.workspaceId);
  const displayId = normalizedOptional(input.displayId);
  const hasWorkflow = Boolean(workflowId);
  const trigger = input.trigger ?? "manual";
  const hasSchedule = Boolean(scheduleId || trigger === "schedule");
  const taskOrigin = goatTaskSpawnOrigin(hasWorkflow);
  const taskKind = goatTaskSpawnKind({ origin: taskOrigin, trigger });

  return captureGoatServerEvent(
    "task_spawned",
    input.userWorkosId,
    {
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      task_id: input.taskId,
      ...(displayId ? { display_id: displayId } : {}),
      task_kind: taskKind,
      task_origin: taskOrigin,
      task_trigger: trigger,
      engine: input.engine,
      model: input.model,
      has_workflow: hasWorkflow,
      has_schedule: hasSchedule,
      ...(workflowId ? { workflow_id: workflowId } : {}),
      ...(scheduleId ? { schedule_id: scheduleId } : {}),
    },
    workspaceId ? { workspaceId } : undefined,
  );
}

function goatTaskSpawnOrigin(hasWorkflow: boolean): GoatTaskSpawnOrigin {
  return hasWorkflow ? "workflow" : "adhoc";
}

function goatTaskSpawnKind(input: {
  origin: GoatTaskSpawnOrigin;
  trigger: GoatTaskSpawnTrigger;
}): GoatTaskSpawnKind {
  if (input.trigger === "schedule") {
    return input.origin === "workflow" ? "scheduled_workflow" : "scheduled_task";
  }
  return input.origin;
}

function normalizedOptional(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function captureGoatModelSpendRecorded(input: {
  userWorkosId: string;
  workspaceId?: string | null;
  billingSource: GoatModelSpendBillingSource;
  surface: GoatModelSpendSurface;
  model: string;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  totalCostUsdMicros: number;
  modelCostUsdMicros?: number;
  stage?: string;
  engine?: GoatModelSpendEngine;
  usageSource?: GoatAnalyticsUsageSource;
  ledgerId?: number | null;
  chatSessionId?: string | null;
  ingestJobId?: string | null;
  taskId?: string | null;
  messageId?: string | null;
}) {
  const modelCostUsdMicros = analyticsNumber(
    input.modelCostUsdMicros ?? input.providerCostUsdMicros,
  );
  if (modelCostUsdMicros <= 0) return Promise.resolve();
  const usageSource = input.usageSource ?? usageSourceForOptionalEngine(input.engine);

  return captureGoatServerEvent("model_spend_recorded", input.userWorkosId, {
    user_id: input.userWorkosId,
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    billing_source: input.billingSource,
    surface: input.surface,
    model: input.model,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.engine ? { engine: input.engine } : {}),
    ...(usageSource ? { usage_source: usageSource } : {}),
    provider_cost_usd_micros: analyticsNumber(input.providerCostUsdMicros),
    platform_fee_usd_micros: analyticsNumber(input.platformFeeUsdMicros),
    total_cost_usd_micros: analyticsNumber(input.totalCostUsdMicros),
    model_cost_usd_micros: modelCostUsdMicros,
    ...(input.ledgerId ? { ledger_id: input.ledgerId } : {}),
    ...(input.chatSessionId ? { chat_session_id: input.chatSessionId } : {}),
    ...(input.ingestJobId ? { ingest_job_id: input.ingestJobId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.messageId ? { message_id: input.messageId } : {}),
  });
}

export type GoatLlmUsageRecordedAnalyticsInput = {
  distinctId: string;
  workspaceId?: string | null | undefined;
  surface: GoatLlmUsageAnalyticsSurface;
  stage: GoatLlmUsageAnalyticsStage;
  sessionId?: string | null | undefined;
  messageId?: string | null | undefined;
  taskId?: string | null | undefined;
  turnId?: string | null | undefined;
  stepIndex?: number | null | undefined;
  modelProvider: string;
  model: string;
  responseModel?: string | null | undefined;
  engine: GoatAnalyticsEngine;
  usageSource?: GoatAnalyticsUsageSource | undefined;
  inputTokens: number;
  inputNoCacheTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  outputTextTokens: number;
  outputReasoningTokens: number;
  totalTokens: number;
  providerCostUsdMicros: number;
  platformFeeUsdMicros: number;
  chargedCostUsdMicros: number;
  billable: boolean;
  finishReason?: string | null | undefined;
};

export function captureGoatLlmUsageRecorded(input: GoatLlmUsageRecordedAnalyticsInput) {
  return captureGoatServerEvent("llm_usage_recorded", input.distinctId, {
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    surface: input.surface,
    stage: input.stage,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.messageId ? { message_id: input.messageId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.turnId ? { turn_id: input.turnId } : {}),
    ...(typeof input.stepIndex === "number" ? { step_index: input.stepIndex } : {}),
    model_provider: input.modelProvider,
    model: input.model,
    ...(input.responseModel ? { response_model: input.responseModel } : {}),
    engine: input.engine,
    usage_source: input.usageSource ?? goatAnalyticsUsageSourceForEngine(input.engine),
    input_tokens: analyticsNumber(input.inputTokens),
    input_no_cache_tokens: analyticsNumber(input.inputNoCacheTokens),
    input_cache_read_tokens: analyticsNumber(input.inputCacheReadTokens),
    input_cache_write_tokens: analyticsNumber(input.inputCacheWriteTokens),
    output_tokens: analyticsNumber(input.outputTokens),
    output_text_tokens: analyticsNumber(input.outputTextTokens),
    output_reasoning_tokens: analyticsNumber(input.outputReasoningTokens),
    total_tokens: analyticsNumber(input.totalTokens),
    provider_cost_usd_micros: analyticsNumber(input.providerCostUsdMicros),
    platform_fee_usd_micros: analyticsNumber(input.platformFeeUsdMicros),
    charged_cost_usd_micros: analyticsNumber(input.chargedCostUsdMicros),
    billable: input.billable,
    ...(input.finishReason ? { finish_reason: input.finishReason } : {}),
  });
}

function analyticsNumber(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function goatAnalyticsUsageSourceForEngine(
  engine: GoatAnalyticsEngine,
): GoatAnalyticsUsageSource {
  return engine === "opencompany" ? "owned_platform" : "external_harness";
}

function usageSourceForOptionalEngine(
  engine: GoatAnalyticsEngine | undefined,
): GoatAnalyticsUsageSource | undefined {
  return engine ? goatAnalyticsUsageSourceForEngine(engine) : undefined;
}
