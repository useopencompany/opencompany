import { describe, expect, it } from "vitest";
import {
  goatAttioEventClaimKey,
  goatAttioEventTypeFor,
  goatAttioRouteMatchesEvent,
  goatAttioSelectedEventTypes,
  goatAttioSelectedObjectTypes,
  parseGoatAttioBrainSourceConfig,
} from "./goat-attio";

describe("Goat Attio brain source config", () => {
  it("keeps missing events as all events for backwards compatibility", () => {
    const config = parseGoatAttioBrainSourceConfig({
      objectTypes: [{ id: "deal" }],
    });

    expect(goatAttioSelectedEventTypes(config)).toBeNull();
    expect(goatAttioRouteMatchesEvent(config, "object_created")).toBe(true);
    expect(goatAttioRouteMatchesEvent(config, "note_added")).toBe(true);
  });

  it("preserves an explicit empty event selection", () => {
    const config = parseGoatAttioBrainSourceConfig({
      objectTypes: [{ id: "deal" }],
      events: [],
    });

    expect(goatAttioSelectedEventTypes(config)).toEqual(new Set());
    expect(goatAttioRouteMatchesEvent(config, "object_created")).toBe(false);
  });

  it("parses selected object types and events, dropping unknown ids", () => {
    const config = parseGoatAttioBrainSourceConfig({
      objectTypes: [{ id: "person" }, "deal", { id: "workspace" }],
      events: [{ id: "object_created" }, "note_added", { id: "unknown" }],
    });

    expect(goatAttioSelectedObjectTypes(config)).toEqual(new Set(["person", "deal"]));
    expect(goatAttioSelectedEventTypes(config)).toEqual(new Set(["object_created", "note_added"]));
  });

  it("maps buffer actions to routing event types", () => {
    expect(goatAttioEventTypeFor("create")).toBe("object_created");
    expect(goatAttioEventTypeFor("update")).toBe("object_updated");
    expect(goatAttioEventTypeFor("note")).toBe("note_added");
  });
});

describe("goatAttioEventClaimKey", () => {
  const base = {
    workspaceId: "ws_1",
    objectType: "deal" as const,
    recordId: "rec_1",
    eventTime: new Date("2026-07-17T10:15:00.000Z"),
  };

  it("keys note events on the stable note id", () => {
    expect(goatAttioEventClaimKey({ ...base, action: "note", noteId: "note_9" })).toBe(
      "ws_1:deal:rec_1:note:note_9",
    );
  });

  it("keys creation events on the record alone", () => {
    expect(goatAttioEventClaimKey({ ...base, action: "create" })).toBe("ws_1:deal:rec_1:created");
  });

  it("keys attribute updates on attribute plus day so same-day edits coalesce", () => {
    const key = goatAttioEventClaimKey({ ...base, action: "update", attributeId: "attr_5" });
    expect(key).toBe("ws_1:deal:rec_1:updated:attr_5:2026-07-17");
    const sameDayLater = goatAttioEventClaimKey({
      ...base,
      action: "update",
      attributeId: "attr_5",
      eventTime: new Date("2026-07-17T23:59:00.000Z"),
    });
    expect(sameDayLater).toBe(key);
    const nextDay = goatAttioEventClaimKey({
      ...base,
      action: "update",
      attributeId: "attr_5",
      eventTime: new Date("2026-07-18T00:01:00.000Z"),
    });
    expect(nextDay).not.toBe(key);
  });
});
