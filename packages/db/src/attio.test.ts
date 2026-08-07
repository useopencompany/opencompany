import { describe, expect, it } from "vitest";
import {
  attioEventClaimKey,
  attioEventTypeFor,
  attioRouteMatchesEvent,
  attioSelectedEventTypes,
  attioSelectedObjectTypes,
  parseAttioBrainSourceConfig,
} from "./attio";

describe("Attio brain source config", () => {
  it("uses creation and notes as the safe default event selection", () => {
    const config = parseAttioBrainSourceConfig({
      objectTypes: [{ id: "deal" }],
    });

    expect(attioSelectedEventTypes(config)).toEqual(new Set(["object_created", "note_added"]));
    expect(attioRouteMatchesEvent(config, "object_created")).toBe(true);
    expect(attioRouteMatchesEvent(config, "note_added")).toBe(true);
    expect(attioRouteMatchesEvent(config, "object_updated")).toBe(false);
  });

  it("preserves an explicit empty event selection", () => {
    const config = parseAttioBrainSourceConfig({
      objectTypes: [{ id: "deal" }],
      events: [],
    });

    expect(attioSelectedEventTypes(config)).toEqual(new Set());
    expect(attioRouteMatchesEvent(config, "object_created")).toBe(false);
  });

  it("parses selected object types and events, dropping unknown ids", () => {
    const config = parseAttioBrainSourceConfig({
      objectTypes: [{ id: "person" }, "deal", { id: "workspace" }],
      events: [{ id: "object_created" }, "note_added", { id: "unknown" }],
    });

    expect(attioSelectedObjectTypes(config)).toEqual(new Set(["person", "deal"]));
    expect(attioSelectedEventTypes(config)).toEqual(new Set(["object_created", "note_added"]));
  });

  it("maps buffer actions to routing event types", () => {
    expect(attioEventTypeFor("create")).toBe("object_created");
    expect(attioEventTypeFor("update")).toBe("object_updated");
    expect(attioEventTypeFor("note")).toBe("note_added");
  });

  it("always excludes Attio system record updates, including legacy opt-ins", () => {
    const config = parseAttioBrainSourceConfig({
      objectTypes: [{ id: "person" }],
      events: [{ id: "object_updated" }],
      includeSystemUpdates: true,
    });

    expect(config).not.toHaveProperty("includeSystemUpdates");
    expect(attioRouteMatchesEvent(config, "object_updated", { actorType: "system" })).toBe(false);
    expect(
      attioRouteMatchesEvent(config, "object_updated", { actorType: "workspace-member" }),
    ).toBe(true);
  });
});

describe("attioEventClaimKey", () => {
  const base = {
    workspaceId: "ws_1",
    objectType: "deal" as const,
    recordId: "rec_1",
    eventTime: new Date("2026-07-17T10:15:00.000Z"),
  };

  it("keys note events on the stable note id", () => {
    expect(attioEventClaimKey({ ...base, action: "note", noteId: "note_9" })).toBe(
      "ws_1:deal:rec_1:note:note_9",
    );
  });

  it("keys creation events on the record alone", () => {
    expect(attioEventClaimKey({ ...base, action: "create" })).toBe("ws_1:deal:rec_1:created");
  });

  it("coalesces nearby copies of an attribute update without suppressing a later window", () => {
    const key = attioEventClaimKey({ ...base, action: "update", attributeId: "attr_5" });
    expect(key).toBe("ws_1:deal:rec_1:updated:attr_5:2026-07-17T10:15:00.000Z");
    const nearbyCopy = attioEventClaimKey({
      ...base,
      action: "update",
      attributeId: "attr_5",
      eventTime: new Date("2026-07-17T10:19:59.000Z"),
    });
    expect(nearbyCopy).toBe(key);
    const laterWindow = attioEventClaimKey({
      ...base,
      action: "update",
      attributeId: "attr_5",
      eventTime: new Date("2026-07-17T10:20:00.000Z"),
    });
    expect(laterWindow).not.toBe(key);
  });
});
