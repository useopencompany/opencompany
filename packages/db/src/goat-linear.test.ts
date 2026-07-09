import { describe, expect, it } from "vitest";
import {
  goatLinearEventTypeFor,
  goatLinearRouteMatchesEvent,
  goatLinearSelectedEventTypes,
  parseGoatLinearBrainSourceConfig,
} from "./goat-linear";

describe("Goat Linear brain source config", () => {
  it("keeps missing events as all events for backwards compatibility", () => {
    const config = parseGoatLinearBrainSourceConfig({
      teams: [{ id: "team_1", key: "ENG", name: "Engineering" }],
    });

    expect(goatLinearSelectedEventTypes(config)).toBeNull();
    expect(goatLinearRouteMatchesEvent(config, "issue_created")).toBe(true);
    expect(goatLinearRouteMatchesEvent(config, "comment_created")).toBe(true);
  });

  it("preserves an explicit empty event selection", () => {
    const config = parseGoatLinearBrainSourceConfig({
      teams: [{ id: "team_1", name: "Engineering" }],
      events: [],
    });

    expect(goatLinearSelectedEventTypes(config)).toEqual(new Set());
    expect(goatLinearRouteMatchesEvent(config, "issue_created")).toBe(false);
  });

  it("parses selected event ids and drops unknown events", () => {
    const config = parseGoatLinearBrainSourceConfig({
      events: [{ id: "issue_created" }, "comment_created", { id: "unknown" }],
    });

    expect(goatLinearSelectedEventTypes(config)).toEqual(
      new Set(["issue_created", "comment_created"]),
    );
  });

  it("derives issue status-change events from Linear update payloads", () => {
    expect(
      goatLinearEventTypeFor({
        entityType: "issue",
        action: "update",
        updatedFrom: { stateId: "old_state" },
      }),
    ).toBe("issue_status_changed");
    expect(
      goatLinearEventTypeFor({
        entityType: "issue",
        action: "update",
        updatedFrom: { assigneeId: "old_user" },
      }),
    ).toBe("issue_updated");
  });

  it("derives issue and comment lifecycle events", () => {
    expect(goatLinearEventTypeFor({ entityType: "issue", action: "create" })).toBe("issue_created");
    expect(goatLinearEventTypeFor({ entityType: "issue", action: "remove" })).toBe("issue_removed");
    expect(goatLinearEventTypeFor({ entityType: "comment", action: "create" })).toBe(
      "comment_created",
    );
    expect(goatLinearEventTypeFor({ entityType: "comment", action: "update" })).toBe(
      "comment_updated",
    );
  });
});
