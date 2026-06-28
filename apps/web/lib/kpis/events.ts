import { inngest } from "@/lib/inngest/client";

export const KPI_EVALUATION_REQUESTED_EVENT = "opencompany.kpi_evaluation_requested";

export type KpiEvaluationRequestedInput = {
  workspaceId: string;
  kpiId: string;
};

export function triggerKpiEvaluation(input: KpiEvaluationRequestedInput) {
  return inngest.send({ name: KPI_EVALUATION_REQUESTED_EVENT, data: input });
}
