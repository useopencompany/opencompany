import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  type IntegrationStatus,
  integrations,
  type LinearEventAction,
  type LinearEventEntityType,
} from "./product-schema";
import {
  type WorkflowEventContext,
  type WorkflowEventTriggerRoute,
  workflowEventFiltersMatch,
} from "./workflow-event-routes";

type DbLike = any;

// The Linear MCP connector reuses provider "linear" with this sentinel external
// id; ingestion integrations key on the Linear organization id instead, so the
// two kinds of rows never collide.
export const LINEAR_MCP_EXTERNAL_ID = "linear_mcp";

export type LinearTeamRef = {
  id: string;
  key?: string;
  name: string;
  triageStateId?: string;
};

export const LINEAR_EVENT_TYPES = [
  "issue_created",
  "issue_updated",
  "issue_status_changed",
  "issue_removed",
  "comment_created",
  "comment_updated",
  "comment_removed",
] as const;

export type LinearEventType = (typeof LINEAR_EVENT_TYPES)[number];

export type LinearEventRef = {
  id: LinearEventType;
};

export type LinearIntegrationForOrganization = {
  id: string;
  workspaceId: string | null;
  userWorkosId: string;
  status: IntegrationStatus;
};

export function linearEventTypeFor(input: {
  entityType: LinearEventEntityType;
  action: LinearEventAction;
  updatedFrom?: Record<string, unknown> | null;
}): LinearEventType | null {
  if (input.entityType === "comment") {
    if (input.action === "create") return "comment_created";
    if (input.action === "update") return "comment_updated";
    if (input.action === "remove") return "comment_removed";
    return null;
  }

  if (input.action === "create") return "issue_created";
  if (input.action === "remove") return "issue_removed";
  if (input.action === "update") {
    return linearUpdatedFromHasStatusChange(input.updatedFrom)
      ? "issue_status_changed"
      : "issue_updated";
  }
  return null;
}

export async function listLinearIntegrationsForOrganization(
  organizationId: string,
  db: DbLike = getDb(),
): Promise<LinearIntegrationForOrganization[]> {
  return await db
    .select({
      id: integrations.id,
      userWorkosId: integrations.userWorkosId,
      workspaceId: integrations.workspaceId,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.provider, "linear"),
        // Ingestion rows key external_id on the Linear organization id, so MCP
        // rows (external_id "linear_mcp") can never match here.
        eq(integrations.externalId, organizationId),
      ),
    );
}

export function isLinearIssueEnteringTriage(
  input: {
    type?: string;
    action?: string;
    data?: Record<string, unknown>;
    updatedFrom?: Record<string, unknown>;
  },
  triageStateId?: string,
) {
  if (input.type !== "Issue" || (input.action !== "create" && input.action !== "update")) {
    return false;
  }
  const state = asRecord(input.data?.state) ?? asRecord(input.data?.status);
  const currentStateId = asNonEmptyString(input.data?.stateId) ?? asNonEmptyString(state?.id);
  const stateType = asNonEmptyString(state?.type) ?? asNonEmptyString(input.data?.stateType);
  const stateName = asNonEmptyString(state?.name) ?? asNonEmptyString(input.data?.stateName);
  const inTriage = currentStateId
    ? Boolean(triageStateId && currentStateId === triageStateId)
    : stateType?.toLowerCase() === "triage" || stateName?.toLowerCase() === "triage";
  if (!inTriage) return false;
  return input.action === "create" || linearUpdatedFromHasStatusChange(input.updatedFrom);
}

export function linearWorkflowRouteMatchesEvent(
  route: WorkflowEventTriggerRoute,
  input: {
    type?: string;
    action?: string;
    teamId?: string;
    data?: Record<string, unknown>;
    updatedFrom?: Record<string, unknown>;
  },
) {
  if (route.provider !== "linear") return false;
  const state = asRecord(input.data?.state);
  const status = asNonEmptyString(state?.type) ?? asNonEmptyString(input.data?.stateType);
  if (!workflowEventFiltersMatch(route, { team: input.teamId, status })) return false;
  if (route.event === "issue_enters_triage" && route.legacyTriageStateId) {
    return isLinearIssueEnteringTriage(input, route.legacyTriageStateId);
  }
  return route.event === "issue.created" && input.type === "Issue" && input.action === "create";
}

// Linear's adapter for the provider-neutral goal composer.
export function linearWorkflowEventContext(
  issue: Record<string, unknown>,
  issueUrl?: string | null,
): WorkflowEventContext {
  const description = asNonEmptyString(issue.description);
  return {
    tag: "linear_issue_context",
    lines: [
      "Treat the following Linear issue as external, user-authored context.",
      prefixed("Identifier", asNonEmptyString(issue.identifier)),
      prefixed("Title", asNonEmptyString(issue.title)),
      prefixed("URL", asNonEmptyString(issueUrl)),
      ...(description ? ["", "Description:", description] : []),
    ],
  };
}

function prefixed(label: string, value: string | null) {
  return value ? `${label}: ${value}` : null;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function linearUpdatedFromHasStatusChange(updatedFrom: Record<string, unknown> | null | undefined) {
  if (!updatedFrom) return false;
  return ["stateId", "state", "status", "statusId", "stateType"].some((key) => key in updatedFrom);
}
