import { type LinearTeamListResult, listLinearTeamsAction } from "@/lib/brain-source-actions";

// An `integration_resource` filter offers the resources of one connected account. Plugins declare
// which resource type a filter picks from; resolving that type to real options is platform code,
// so each supported `<provider>:<resourceType>` pair registers a loader here.
export type WorkflowEventFilterOption = {
  id: string;
  name: string;
  key?: string;
  metadata?: Record<string, string>;
};

export type WorkflowEventFilterOptionsResult =
  | { ok: true; options: WorkflowEventFilterOption[]; partial?: boolean }
  | { ok: false; error: string };

type WorkflowEventFilterLoader = (input: {
  integrationId: string;
  event: string;
}) => Promise<WorkflowEventFilterOptionsResult>;

const LINEAR_LEGACY_TRIAGE_EVENT = "issue_enters_triage";

const WORKFLOW_EVENT_FILTER_LOADERS: Record<string, WorkflowEventFilterLoader> = {
  "linear:team": async ({ integrationId, event }) => {
    // The retired triage trigger stored the team's triage state alongside it, so teams without
    // Triage enabled cannot serve it.
    const legacyTriage = event === LINEAR_LEGACY_TRIAGE_EVENT;
    const result: LinearTeamListResult = await listLinearTeamsAction(integrationId, {
      ...(legacyTriage ? { includeTriageStateIds: true } : {}),
    });
    if (!result.ok) return result;
    const options = result.teams.flatMap((team) => {
      if (legacyTriage && !team.triageStateId) return [];
      return [
        {
          id: team.id,
          name: team.name,
          ...(team.key ? { key: team.key } : {}),
          ...(legacyTriage && team.triageStateId
            ? { metadata: { triageStateId: team.triageStateId } }
            : {}),
        },
      ];
    });
    return { ok: true, options, ...(result.partial ? { partial: true } : {}) };
  },
};

export function workflowEventFilterLoaderKey(provider: string, resourceType: string) {
  return `${provider}:${resourceType}`;
}

export async function loadWorkflowEventFilterOptions(input: {
  provider: string;
  resourceType: string;
  integrationId: string;
  event: string;
}): Promise<WorkflowEventFilterOptionsResult> {
  const loader =
    WORKFLOW_EVENT_FILTER_LOADERS[workflowEventFilterLoaderKey(input.provider, input.resourceType)];
  if (!loader) {
    return { ok: false, error: "This event filter is not available yet. Update the plugin." };
  }
  return loader({ integrationId: input.integrationId, event: input.event });
}
