import { describe, expect, it } from "vitest";
import {
  isLinearIssueEnteringTriage,
  linearEventTypeFor,
  linearRouteMatchesEvent,
  linearSelectedEventTypes,
  linearWorkflowRouteMatchesEvent,
  parseLinearBrainSourceConfig,
  parseLinearWikiSourceConfig,
  parseWorkflowEventConfig,
} from "./linear";

describe("opencompany Linear brain source config", () => {
  it("keeps missing events as all events for backwards compatibility", () => {
    const config = parseLinearBrainSourceConfig({
      teams: [{ id: "team_1", key: "ENG", name: "Engineering" }],
    });

    expect(linearSelectedEventTypes(config)).toBeNull();
    expect(linearRouteMatchesEvent(config, "issue_created")).toBe(true);
    expect(linearRouteMatchesEvent(config, "comment_created")).toBe(true);
  });

  it("preserves an explicit empty event selection", () => {
    const config = parseLinearBrainSourceConfig({
      teams: [{ id: "team_1", name: "Engineering" }],
      events: [],
    });

    expect(linearSelectedEventTypes(config)).toEqual(new Set());
    expect(linearRouteMatchesEvent(config, "issue_created")).toBe(false);
  });

  it("parses selected event ids and drops unknown events", () => {
    const config = parseLinearBrainSourceConfig({
      events: [{ id: "issue_created" }, "comment_created", { id: "unknown" }],
    });

    expect(linearSelectedEventTypes(config)).toEqual(new Set(["issue_created", "comment_created"]));
  });

  it("parses wiki team scope with the same strict shape as brain routing", () => {
    expect(
      parseLinearWikiSourceConfig({
        teams: [
          { id: " team_1 ", key: " ENG ", name: " Engineering " },
          { id: "", name: "Dropped" },
        ],
        events: [{ id: "issue_created" }, { id: "unknown" }],
      }),
    ).toEqual({
      teams: [{ id: "team_1", key: "ENG", name: "Engineering" }],
      events: [{ id: "issue_created" }],
    });
  });

  it("derives issue status-change events from Linear update payloads", () => {
    expect(
      linearEventTypeFor({
        entityType: "issue",
        action: "update",
        updatedFrom: { stateId: "old_state" },
      }),
    ).toBe("issue_status_changed");
    expect(
      linearEventTypeFor({
        entityType: "issue",
        action: "update",
        updatedFrom: { assigneeId: "old_user" },
      }),
    ).toBe("issue_updated");
  });

  it("derives issue and comment lifecycle events", () => {
    expect(linearEventTypeFor({ entityType: "issue", action: "create" })).toBe("issue_created");
    expect(linearEventTypeFor({ entityType: "issue", action: "remove" })).toBe("issue_removed");
    expect(linearEventTypeFor({ entityType: "comment", action: "create" })).toBe("comment_created");
    expect(linearEventTypeFor({ entityType: "comment", action: "update" })).toBe("comment_updated");
  });

  it("matches creates and state changes into triage without retriggering unrelated updates", () => {
    expect(
      isLinearIssueEnteringTriage({
        type: "Issue",
        action: "create",
        data: { state: { type: "triage", name: "Triage" } },
      }),
    ).toBe(true);
    expect(
      isLinearIssueEnteringTriage({
        type: "Issue",
        action: "update",
        data: { state: { name: "Triage" } },
        updatedFrom: { stateId: "previous_state" },
      }),
    ).toBe(true);
    expect(
      isLinearIssueEnteringTriage({
        type: "Issue",
        action: "update",
        data: { state: { type: "triage" } },
        updatedFrom: { priority: 2 },
      }),
    ).toBe(false);
    expect(
      isLinearIssueEnteringTriage(
        {
          type: "Issue",
          action: "update",
          data: { stateId: "state_triage" },
          updatedFrom: { stateId: "previous_state" },
        },
        "state_triage",
      ),
    ).toBe(true);
  });

  it("does not trust a triage label when Linear supplies a different state id", () => {
    expect(
      isLinearIssueEnteringTriage(
        {
          type: "Issue",
          action: "create",
          data: { state: { id: "state_backlog", name: "Triage", type: "triage" } },
        },
        "state_triage",
      ),
    ).toBe(false);
  });

  it("matches issue.created routes by declared team filters", () => {
    const route = {
      workflowId: "workflow_1",
      workspaceId: "workspace_1",
      userWorkosId: "user_1",
      workflowSlug: "new-issue",
      workflowName: "New issue",
      prompt: "Review it.",
      harnessSpec: {} as never,
      provider: "linear",
      event: "issue.created",
      filters: { team: { id: "team_1" } },
    };
    expect(
      linearWorkflowRouteMatchesEvent(route, {
        type: "Issue",
        action: "create",
        teamId: "team_1",
      }),
    ).toBe(true);
    expect(
      linearWorkflowRouteMatchesEvent(route, {
        type: "Issue",
        action: "create",
        teamId: "team_2",
      }),
    ).toBe(false);
    expect(
      linearWorkflowRouteMatchesEvent(route, {
        type: "Issue",
        action: "update",
        teamId: "team_1",
      }),
    ).toBe(false);
  });

  it("keeps normalized legacy triage subscriptions routable", () => {
    expect(
      parseWorkflowEventConfig({
        provider: "linear",
        event: "issue_enters_triage",
        integrationId: "gint_1",
        filters: {
          team: {
            id: "team_1",
            name: "Engineering",
            metadata: { triageStateId: "state_triage" },
          },
        },
        prompt: "Review it.",
      }),
    ).toEqual({
      provider: "linear",
      event: "issue_enters_triage",
      integrationId: "gint_1",
      filters: { team: { id: "team_1" } },
      prompt: "Review it.",
      legacyTriageStateId: "state_triage",
    });
  });
});
