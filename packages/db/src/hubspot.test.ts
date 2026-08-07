import { describe, expect, it } from "vitest";
import {
  hubspotEventTypeFor,
  hubspotRouteMatchesEvent,
  hubspotSelectedEventTypes,
  hubspotSelectedObjectTypes,
  parseHubspotBrainSourceConfig,
} from "./hubspot";

describe("HubSpot brain source config", () => {
  it("keeps missing events as all events for backwards compatibility", () => {
    const config = parseHubspotBrainSourceConfig({
      objectTypes: [{ id: "deal" }],
    });

    expect(hubspotSelectedEventTypes(config)).toBeNull();
    expect(hubspotRouteMatchesEvent(config, "object_created")).toBe(true);
    expect(hubspotRouteMatchesEvent(config, "object_stage_changed")).toBe(true);
  });

  it("preserves an explicit empty event selection", () => {
    const config = parseHubspotBrainSourceConfig({
      objectTypes: [{ id: "deal" }],
      events: [],
    });

    expect(hubspotSelectedEventTypes(config)).toEqual(new Set());
    expect(hubspotRouteMatchesEvent(config, "object_created")).toBe(false);
  });

  it("parses selected object types and events, dropping unknown ids", () => {
    const config = parseHubspotBrainSourceConfig({
      objectTypes: [{ id: "contact" }, "deal", { id: "ticket" }],
      events: [{ id: "object_created" }, "object_updated", { id: "unknown" }],
    });

    expect(hubspotSelectedObjectTypes(config)).toEqual(new Set(["contact", "deal"]));
    expect(hubspotSelectedEventTypes(config)).toEqual(
      new Set(["object_created", "object_updated"]),
    );
  });

  it("derives stage-change events from stage property updates", () => {
    expect(hubspotEventTypeFor({ action: "update", propertyName: "dealstage" })).toBe(
      "object_stage_changed",
    );
    expect(hubspotEventTypeFor({ action: "update", propertyName: "lifecyclestage" })).toBe(
      "object_stage_changed",
    );
    expect(hubspotEventTypeFor({ action: "update", propertyName: "amount" })).toBe(
      "object_updated",
    );
    expect(hubspotEventTypeFor({ action: "update", propertyName: null })).toBe("object_updated");
  });

  it("derives creation events regardless of property name", () => {
    expect(hubspotEventTypeFor({ action: "create" })).toBe("object_created");
  });
});
