import type { Actor, PluginEventDefinition, WorkflowEventTrigger } from "@opencompany/core";
import { sql } from "drizzle-orm";
import type { WorkflowSqlExecute } from "./workflow-repository";

type SubscriptionRow = {
  integrationId: string | null;
  events: unknown;
  eventModes: unknown;
};

export async function validateWorkflowEventSubscription(
  execute: WorkflowSqlExecute,
  input: { actor: Actor; trigger: WorkflowEventTrigger },
): Promise<string | null> {
  const rows = rowsFromExecute<SubscriptionRow>(
    await execute(sql`
      SELECT
        integration.id AS "integrationId",
        plugin.events,
        plugin.event_modes AS "eventModes"
      FROM goat.integrations AS integration
      LEFT JOIN goat.plugins AS plugin
        ON plugin.workspace_id = ${input.actor.workspaceId}
       AND plugin.name = ${input.trigger.provider}
       AND plugin.status = 'enabled'
       AND plugin.archived_at IS NULL
      WHERE integration.id = ${input.trigger.integrationId}
        AND integration.user_workos_id = ${input.actor.userId}
        AND integration.provider = ${input.trigger.provider}
        AND integration.status = 'connected'
      ORDER BY plugin.updated_at DESC NULLS LAST
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row?.integrationId) return "Event triggers need a connected provider account.";

  // Historical subscriptions predate plugin event declarations. They remain authorable so an
  // unchanged workflow can still be edited and continue firing during the v1 migration.
  if (input.trigger.provider === "linear" && input.trigger.event === "issue_enters_triage") {
    return input.trigger.filters.team?.metadata?.triageStateId
      ? null
      : "Legacy Linear triage triggers need a team triage state.";
  }

  const events = pluginEvents(row.events);
  const declaration = events.find((event) => event.id === input.trigger.event);
  const modes = isRecord(row.eventModes) ? row.eventModes : {};
  if (!declaration || modes[input.trigger.event] !== true) {
    return "Enable this plugin event before activating the workflow.";
  }
  const declaredFilters = new Map(declaration.filters.map((filter) => [filter.id, filter]));
  if (Object.keys(input.trigger.filters).some((id) => !declaredFilters.has(id))) {
    return "The workflow contains a filter this plugin event does not declare.";
  }
  if (
    declaration.filters.some(
      (filter) => filter.required && input.trigger.filters[filter.id] === undefined,
    )
  ) {
    return "Choose a value for every required event filter.";
  }
  return null;
}

function pluginEvents(value: unknown): PluginEventDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (event): event is PluginEventDefinition =>
      isRecord(event) &&
      typeof event.id === "string" &&
      typeof event.label === "string" &&
      typeof event.description === "string" &&
      event.delivery === "webhook" &&
      Array.isArray(event.filters),
  );
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (isRecord(result) && Array.isArray(result.rows)) return result.rows as T[];
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
