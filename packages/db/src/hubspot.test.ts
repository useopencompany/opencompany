import { describe, expect, it } from "vitest";
import {
  goatHubspotEventTypeFor,
  goatHubspotRouteMatchesEvent,
  goatHubspotSelectedEventTypes,
  goatHubspotSelectedObjectTypes,
  parseGoatHubspotBrainSourceConfig,
} from "./hubspot";

describe("Goat HubSpot brain source config", () => {
  it("keeps missing events as all events for backwards compatibility", () => {
    const config = parseGoatHubspotBrainSourceConfig({
      objectTypes: [{ id: "deal" }],
    });

    expect(goatHubspotSelectedEventTypes(config)).toBeNull();
    expect(goatHubspotRouteMatchesEvent(config, "object_created")).toBe(true);
    expect(goatHubspotRouteMatchesEvent(config, "object_stage_changed")).toBe(true);
  });

  it("preserves an explicit empty event selection", () => {
    const config = parseGoatHubspotBrainSourceConfig({
      objectTypes: [{ id: "deal" }],
      events: [],
    });

    expect(goatHubspotSelectedEventTypes(config)).toEqual(new Set());
    expect(goatHubspotRouteMatchesEvent(config, "object_created")).toBe(false);
  });

  it("parses selected object types and events, dropping unknown ids", () => {
    const config = parseGoatHubspotBrainSourceConfig({
      objectTypes: [{ id: "contact" }, "deal", { id: "ticket" }],
      events: [{ id: "object_created" }, "object_updated", { id: "unknown" }],
    });

    expect(goatHubspotSelectedObjectTypes(config)).toEqual(new Set(["contact", "deal"]));
    expect(goatHubspotSelectedEventTypes(config)).toEqual(
      new Set(["object_created", "object_updated"]),
    );
  });

  it("derives stage-change events from stage property updates", () => {
    expect(goatHubspotEventTypeFor({ action: "update", propertyName: "dealstage" })).toBe(
      "object_stage_changed",
    );
    expect(goatHubspotEventTypeFor({ action: "update", propertyName: "lifecyclestage" })).toBe(
      "object_stage_changed",
    );
    expect(goatHubspotEventTypeFor({ action: "update", propertyName: "amount" })).toBe(
      "object_updated",
    );
    expect(goatHubspotEventTypeFor({ action: "update", propertyName: null })).toBe(
      "object_updated",
    );
  });

  it("derives creation events regardless of property name", () => {
    expect(goatHubspotEventTypeFor({ action: "create" })).toBe("object_created");
  });
});
