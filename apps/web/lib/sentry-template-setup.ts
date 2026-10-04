import {
  type PreparedWorkflowTemplate,
  prepareWorkflowTemplate,
  type WorkflowTemplate,
  type WorkflowTemplateTriggerInput,
} from "./workflow-templates";
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
export function prepareSentryTemplate(
  template: WorkflowTemplate,
  setup: SentryTemplateSetupValues,
): PreparedWorkflowTemplate {
  if (
    !template.setup?.startsWith("sentry") ||
    !setup.integrationId ||
    !/^\d+$/.test(setup.project.id)
  )
    throw new Error("Choose a selected Sentry project.");
  const filters: Extract<WorkflowTemplateTriggerInput, { type: "event" }>["filters"] = {
    project: setup.project,
  };
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
    return prepareWorkflowTemplate(
      template,
      [
        {
          type: "schedule",
          cron: `${minute} ${hour} * * *`,
          timezone: setup.timezone,
          prompt: template.trigger.prompt,
          enabled: true,
        },
      ],
      {
        instructions: `${template.step.instructions}\n\nSelected Sentry project ID: ${setup.project.id}. Organization connection: ${setup.integrationId}. Query is: is:unresolved lastSeen:-24h. Use an explicit UTC range covering the preceding 24 hours.`,
      },
    );
  }
  if (template.trigger.kind !== "event") throw new Error("Sentry event template has no event.");
  const { trigger } = template;
  const eventTrigger = (event: string): WorkflowTemplateTriggerInput => ({
    type: "event",
    provider: "sentry",
    event,
    integrationId: setup.integrationId,
    filters,
    prompt: trigger.prompt,
  });
  const triggers: PreparedWorkflowTemplate["triggers"] = [
    eventTrigger(trigger.event),
    ...(template.additionalEvents ?? []).map(eventTrigger),
  ];
  if (template.setup !== "sentry-fix") return prepareWorkflowTemplate(template, triggers);
  if (
    !setup.engine ||
    !setup.repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(setup.repository) ||
    !setup.baseBranch?.trim()
  )
    throw new Error("Choose a coding engine, repository and base branch.");
  return prepareWorkflowTemplate(template, triggers, {
    model: setup.engine,
    runtimeModel: setup.engine === "codex" ? "openai/gpt-5.6-sol" : "anthropic/claude-sonnet-5",
    reasoningEffort: "high",
    repository: { fullName: setup.repository, baseBranch: setup.baseBranch },
  });
}
