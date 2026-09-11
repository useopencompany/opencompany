// Provider-neutral routing for event-triggered workflows.
//
// A provider adapter (a signed webhook ingress or a platform poller) resolves its own connected
// integrations, asks for the matching workflow routes, and enqueues one durable run per route.
// Everything a provider must supply is reduced to two values: a delivery id that is stable across
// redeliveries, and a context block describing what happened.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type HarnessSpec,
  type IntegrationStatus,
  plugins,
  workflowEventRuns,
  workflows,
} from "./product-schema";

type DbLike = any;

// The subset of an integration row the router needs. Event triggers bind to personal connections,
// so a workspace-scoped row never routes.
export type WorkflowEventIntegration = {
  id: string;
  workspaceId: string | null;
  userWorkosId: string;
  status: IntegrationStatus;
};

// A provider-composed description of what happened, wrapped by the goal composer. Null lines are
// dropped so adapters can list optional fields inline.
export type WorkflowEventContext = { tag: string; lines: readonly (string | null)[] };

export type WorkflowEventTriggerRoute = {
  workflowId: string;
  workspaceId: string;
  userWorkosId: string;
  workflowSlug: string;
  workflowName: string;
  prompt: string;
  harnessSpec: HarnessSpec;
  provider: string;
  event: string;
  filters: Record<string, { id: string }>;
  legacyTriageStateId?: string;
};

// Budget for one enqueued goal: the authored prompt plus the provider's context block.
const WORKFLOW_EVENT_GOAL_MAX_LENGTH = 10_000;
const WORKFLOW_EVENT_PROMPT_MAX_LENGTH = 8_000;

export async function listWorkflowEventTriggerRoutes(
  input: {
    provider: string;
    integrations: readonly WorkflowEventIntegration[];
  },
  db: DbLike = getDb(),
): Promise<WorkflowEventTriggerRoute[]> {
  const connected = new Map(
    input.integrations
      .filter(
        (integration) => integration.status === "connected" && integration.workspaceId === null,
      )
      .map((integration) => [integration.id, integration.userWorkosId]),
  );
  if (connected.size === 0) return [];

  const rows = await db
    .select({
      workflowId: workflows.id,
      workspaceId: workflows.workspaceId,
      userWorkosId: workflows.eventUserWorkosId,
      workflowSlug: workflows.slug,
      workflowName: workflows.name,
      config: workflows.eventConfig,
      harnessSpec: workflows.eventHarnessSpec,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.trigger, "event"),
        eq(workflows.status, "active"),
        isNull(workflows.archivedAt),
        inArray(workflows.eventUserWorkosId, [...new Set(connected.values())]),
      ),
    );
  if (rows.length === 0) return [];
  const workspaceIds = [
    ...new Set((rows as Array<{ workspaceId: string }>).map((row) => row.workspaceId)),
  ];

  const pluginRows = await db
    .select({
      workspaceId: plugins.workspaceId,
      ownerUserId: plugins.ownerUserId,
      name: plugins.name,
      events: plugins.events,
      eventModes: plugins.eventModes,
    })
    .from(plugins)
    .where(
      and(
        inArray(plugins.workspaceId, workspaceIds),
        eq(plugins.name, input.provider),
        eq(plugins.status, "enabled"),
        sql`EXISTS (SELECT 1 FROM goat.workspace_members member WHERE member.workspace_id = ${plugins.workspaceId} AND member.user_workos_id = ${plugins.ownerUserId})`,
        isNull(plugins.archivedAt),
      ),
    );
  const enabledEvents = new Set<string>();
  for (const row of pluginRows as Array<{
    workspaceId: string;
    ownerUserId: string;
    events: Array<{ id?: unknown }>;
    eventModes: Record<string, unknown>;
  }>) {
    for (const event of Array.isArray(row.events) ? row.events : []) {
      if (typeof event.id === "string" && row.eventModes?.[event.id] === true) {
        enabledEvents.add(`${row.workspaceId}:${row.ownerUserId}:${event.id}`);
      }
    }
  }

  return rows.flatMap(
    (row: {
      workflowId: string;
      workspaceId: string;
      userWorkosId: string | null;
      workflowSlug: string;
      workflowName: string;
      config: unknown;
      harnessSpec: HarnessSpec | null;
    }) => {
      const config = parseWorkflowEventConfig(row.config);
      if (
        !config ||
        config.provider !== input.provider ||
        !row.userWorkosId ||
        !row.harnessSpec ||
        connected.get(config.integrationId) !== row.userWorkosId ||
        !enabledEvents.has(`${row.workspaceId}:${row.userWorkosId}:${config.event}`)
      ) {
        return [];
      }
      return [
        {
          workflowId: row.workflowId,
          workspaceId: row.workspaceId,
          userWorkosId: row.userWorkosId,
          workflowSlug: row.workflowSlug,
          workflowName: row.workflowName,
          prompt: config.prompt,
          harnessSpec: row.harnessSpec,
          provider: config.provider,
          event: config.event,
          filters: config.filters,
          ...(config.legacyTriageStateId
            ? { legacyTriageStateId: config.legacyTriageStateId }
            : {}),
        },
      ];
    },
  );
}

// Every route that matched the delivery gets one durable run. The unique
// (workflow, provider, delivery) index makes redeliveries — a webhook retry or a poller re-seeing
// the same resource — no-ops, so callers can enqueue optimistically.
export async function enqueueWorkflowEventRuns(
  input: {
    routes: readonly WorkflowEventTriggerRoute[];
    deliveryId: string;
    eventAt: Date;
    context: WorkflowEventContext;
  },
  db: DbLike = getDb(),
): Promise<number> {
  if (input.routes.length === 0) return 0;
  const rows = await db
    .insert(workflowEventRuns)
    .values(
      input.routes.map((route) => ({
        id: `workflow_event_run_${randomUUID()}`,
        workflowId: route.workflowId,
        workspaceId: route.workspaceId,
        userWorkosId: route.userWorkosId,
        workflowSlug: route.workflowSlug,
        workflowName: route.workflowName,
        provider: route.provider,
        eventType: route.event,
        deliveryId: input.deliveryId,
        goal: workflowEventGoal(route.prompt, input.context),
        harnessSpec: route.harnessSpec,
        eventAt: input.eventAt,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: workflowEventRuns.id });
  return rows.length;
}

// Declared filters are equality matches on an integration resource id. A filter the author left
// unset (the declaration marked it optional) matches every value.
export function workflowEventFiltersMatch(
  route: WorkflowEventTriggerRoute,
  values: Record<string, string | null | undefined>,
) {
  return Object.entries(route.filters).every(([id, filter]) => filter.id === values[id]);
}

// Composes the enqueued goal: the authored prompt, then the provider context wrapped in a tag so
// the agent can tell instructions from external content. Long context is truncated, never the
// closing tag, and a closing tag smuggled into the content itself is neutralized.
export function workflowEventGoal(prompt: string, context: WorkflowEventContext) {
  const closing = `</${context.tag}>`;
  const suffix = `\n${closing}`;
  const body = context.lines
    .flatMap((line) => (line === null ? [] : [line.replaceAll(closing, `<\\/${context.tag}>`)]))
    .join("\n");
  const promptPart = prompt.trim().slice(0, WORKFLOW_EVENT_PROMPT_MAX_LENGTH);
  const contextBudget = WORKFLOW_EVENT_GOAL_MAX_LENGTH - promptPart.length - suffix.length - 2;
  return `${promptPart}\n\n${`<${context.tag}>\n${body}`.slice(0, contextBudget)}${suffix}`;
}

export function parseWorkflowEventConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const integrationId = asNonEmptyString(record.integrationId);
  const provider = asNonEmptyString(record.provider);
  const event = asNonEmptyString(record.event);
  const prompt = asNonEmptyString(record.prompt);
  if (!integrationId || !provider || !event || !prompt) return null;
  const filtersRecord = asRecord(record.filters);
  if (filtersRecord) {
    const filters = Object.fromEntries(
      Object.entries(filtersRecord).flatMap(([id, filter]) => {
        const filterId = asNonEmptyString(asRecord(filter)?.id);
        return filterId ? [[id, { id: filterId }]] : [];
      }),
    );
    if (Object.keys(filters).length !== Object.keys(filtersRecord).length) return null;
    const legacyTriageStateId =
      provider === "linear" && event === "issue_enters_triage"
        ? asNonEmptyString(asRecord(asRecord(filtersRecord.team)?.metadata)?.triageStateId)
        : null;
    if (provider === "linear" && event === "issue_enters_triage" && !legacyTriageStateId) {
      return null;
    }
    return {
      provider,
      event,
      integrationId,
      filters,
      prompt,
      ...(legacyTriageStateId ? { legacyTriageStateId } : {}),
    };
  }
  // Read-compatibility for rows written before declarative filters: the only shape that ever
  // existed is Linear's triage trigger, which stored its team inline.
  const team = asRecord(record.team);
  const teamId = asNonEmptyString(team?.id);
  const triageStateId = asNonEmptyString(team?.triageStateId);
  if (provider !== "linear" || event !== "issue_enters_triage" || !teamId || !triageStateId) {
    return null;
  }
  return {
    provider,
    event,
    integrationId,
    filters: { team: { id: teamId } },
    prompt,
    legacyTriageStateId: triageStateId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
