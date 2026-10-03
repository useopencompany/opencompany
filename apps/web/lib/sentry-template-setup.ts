import type {
  WorkflowEventFilterValue,
  WorkflowStep,
  WorkflowTriggerInput,
} from "@opencompany/core";
import type { WorkflowTemplate } from "./workflow-templates";
export type SentryTemplateSetupValues = {
  integrationId: string;
  project: { id: string; name: string };
  priority?: string;
  environment?: string;
  tags?: { key: string; value: string }[];
  engine?: "codex" | "claude-code";
  repository?: string;
  baseBranch?: string;
  time?: string;
  timezone?: string;
};
export function sentryTemplateDefinition(
  template: WorkflowTemplate,
  setup: SentryTemplateSetupValues,
): { triggers: WorkflowTriggerInput[]; step: Omit<WorkflowStep, "id"> } {
  if (
    !template.setup?.startsWith("sentry") ||
    !setup.integrationId ||
    !/^\d+$/.test(setup.project.id)
  )
    throw new Error("Choose a selected Sentry project.");
  const step = { ...template.step, model: template.step.model ?? "kimi-k2.6" };
  const filters: Record<string, WorkflowEventFilterValue> = { project: setup.project };
  if (setup.priority) {
    if (!["high", "medium", "low"].includes(setup.priority))
      throw new Error("Choose a supported priority.");
    filters.priority = { id: setup.priority, name: setup.priority };
  }
  if (setup.environment) filters.environment = { id: setup.environment, name: setup.environment };
  if (setup.tags?.length) {
    if (
      setup.tags.length > 16 ||
      setup.tags.some((pair) => !pair.key.trim() || !pair.value.trim()) ||
      new Set(setup.tags.map((pair) => pair.key)).size !== setup.tags.length
    )
      throw new Error("Exact tag keys must be unique and all pairs need values.");
    filters.tags = { id: "exact-tags", name: "Exact tags", pairs: setup.tags };
  }
  if (template.setup === "sentry-daily") {
    if (!setup.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(setup.time) || !setup.timezone)
      throw new Error("Choose a daily time and timezone.");
    try {
      new Intl.DateTimeFormat("en", { timeZone: setup.timezone }).format();
    } catch {
      throw new Error("Choose a valid timezone.");
    }
    const [hour, minute] = setup.time.split(":").map(Number);
    step.instructions += `\n\nSelected Sentry project ID: ${setup.project.id}. Organization connection: ${setup.integrationId}. Query is: is:unresolved lastSeen:-24h. Use an explicit UTC range covering the preceding 24 hours.`;
    return {
      step,
      triggers: [
        {
          type: "schedule",
          cron: `${minute} ${hour} * * *`,
          timezone: setup.timezone,
          prompt: template.trigger.prompt,
          enabled: true,
        },
      ],
    };
  }
  if (template.trigger.kind !== "event") throw new Error("Sentry event template has no event.");
  if (template.setup === "sentry-fix") {
    if (
      !setup.engine ||
      !setup.repository ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(setup.repository) ||
      !setup.baseBranch?.trim()
    )
      throw new Error("Choose a coding engine, repository and base branch.");
    step.model = setup.engine;
    step.runtimeModel =
      setup.engine === "codex" ? "openai/gpt-5.6-sol" : "anthropic/claude-sonnet-5";
    step.reasoningEffort = "high";
    step.instructions += `\n\nSentry fix configuration: ${JSON.stringify({ repository: setup.repository, baseBranch: setup.baseBranch, engine: setup.engine })}\nUse repository ${setup.repository} and base branch ${setup.baseBranch}. These are explicit values, do not infer a different repository or base branch.`;
  }
  return {
    step,
    triggers: [template.trigger.event, ...(template.additionalEvents ?? [])].map((event) => ({
      type: "event",
      provider: "sentry",
      event,
      integrationId: setup.integrationId,
      filters,
      prompt: template.trigger.prompt,
    })),
  };
}
