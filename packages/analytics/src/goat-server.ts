import type { GoatAnalyticsEventName, GoatAnalyticsEventProperties } from "./goat-events";
import { type GoatAnalyticsPerson, goatAnalyticsPersonProperties } from "./goat-person";
import { capturePostHogServerEvent } from "./server-core";

type GoatModelSpendBillingSource =
  GoatAnalyticsEventProperties<"model_spend_recorded">["billing_source"];
type GoatModelSpendEngine = GoatAnalyticsEventProperties<"model_spend_recorded">["engine"];
type GoatModelSpendSurface = GoatAnalyticsEventProperties<"model_spend_recorded">["surface"];

function getGoatPostHogConfig() {
  return {
    token: process.env.NEXT_PUBLIC_GOAT_POSTHOG_TOKEN,
    host: process.env.NEXT_PUBLIC_GOAT_POSTHOG_HOST,
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
  ledgerId?: number | null;
  chatSessionId?: string | null;
  ingestJobId?: string | null;
  taskId?: string | null;
  messageId?: string | null;
}) {
  const modelCostUsdMicros = integerMicros(input.modelCostUsdMicros ?? input.providerCostUsdMicros);
  if (modelCostUsdMicros <= 0) return Promise.resolve();

  return captureGoatServerEvent("model_spend_recorded", input.userWorkosId, {
    user_id: input.userWorkosId,
    ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
    billing_source: input.billingSource,
    surface: input.surface,
    model: input.model,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.engine ? { engine: input.engine } : {}),
    provider_cost_usd_micros: integerMicros(input.providerCostUsdMicros),
    platform_fee_usd_micros: integerMicros(input.platformFeeUsdMicros),
    total_cost_usd_micros: integerMicros(input.totalCostUsdMicros),
    model_cost_usd_micros: modelCostUsdMicros,
    ...(input.ledgerId ? { ledger_id: input.ledgerId } : {}),
    ...(input.chatSessionId ? { chat_session_id: input.chatSessionId } : {}),
    ...(input.ingestJobId ? { ingest_job_id: input.ingestJobId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.messageId ? { message_id: input.messageId } : {}),
  });
}

function integerMicros(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
