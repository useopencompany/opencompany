import { describe, expect, it } from "vitest";
import {
  linearEventTypeFor,
  linearRouteMatchesEvent,
  linearSelectedEventTypes,
  parseLinearBrainSourceConfig,
} from "./linear";

describe("Linear brain source config", () => {
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
});
