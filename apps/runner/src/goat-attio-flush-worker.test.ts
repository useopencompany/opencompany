import { describe, expect, it } from "vitest";
import {
  buildAttioObjectWindowItem,
  canRouteAttioWindow,
  hasUsableAttioRecordIdentity,
  selectAttioWindowEventsForFlush,
} from "./goat-attio-flush-worker";

describe("buildAttioObjectWindowItem", () => {
  const window = {
    integrationId: "gint_attio_1",
    userWorkosId: "user_1",
    workspaceId: "ws_62515",
    objectType: "deal" as const,
    recordId: "rec_9876",
  };

  it("builds a snapshot-enriched window item with resolved attribute names and notes", () => {
    const item = buildAttioObjectWindowItem({
      window,
      events: [
        {
          id: "gattevt_1",
          deliveryId: "updated:rec_9876:attr_stage:x",
          action: "update",
          attributeId: "attr_stage",
          noteId: null,
          payload: { actorType: "workspace-member" },
          eventTime: "2026-07-16T10:00:00.000Z",
        },
        {
          id: "gattevt_2",
          deliveryId: "note:note_1",
          action: "note",
          attributeId: null,
          noteId: "note_1",
          payload: {},
          eventTime: "2026-07-16T10:05:00.000Z",
        },
      ],
      enrichment: {
        snapshot: {
          name: "Acme renewal",
          url: "https://app.attio.com/acme/deals/rec_9876",
          stage: "Closed won",
          properties: { name: "Acme renewal", stage: "Closed won", value: "12000" },
          createdAt: "2026-07-01T09:00:00.000Z",
        },
        attributeTitles: new Map([["attr_stage", "Stage"]]),
        notes: [
          {
            noteId: "note_1",
            title: "Renewal call",
            createdAt: "2026-07-16T10:05:00.000Z",
            content: "Agreed on a two-year term.",
          },
        ],
        routingEnabled: true,
      },
      flushedAt: new Date("2026-07-16T10:30:00.000Z"),
    });

    expect(item.sourceProvider).toBe("attio");
    expect(item.sourceType).toBe("activity");
    expect(item.sourceRef).toBe("attio:ws_62515:deal:rec_9876");
    expect(item.title).toBe("Acme renewal");
    expect(item.content.object.stage).toBe("Closed won");
    expect(item.content.object.activity[0]).toMatchObject({
      action: "update",
      attributeName: "Stage",
      actorType: "workspace-member",
    });
    expect(item.content.object.activity[1]).toMatchObject({
      action: "note",
      noteTitle: "Renewal call",
    });
    expect(item.content.object.notes?.[0]?.content).toBe("Agreed on a two-year term.");
  });

  it("marks the snapshot stale and falls back to the record id without enrichment", () => {
    const item = buildAttioObjectWindowItem({
      window,
      events: [
        {
          id: "gattevt_3",
          deliveryId: "updated:rec_9876:attr_x:y",
          action: "update",
          attributeId: "attr_x",
          noteId: null,
          payload: {},
          eventTime: "2026-07-16T10:00:00.000Z",
        },
      ],
      enrichment: {
        snapshot: null,
        attributeTitles: new Map(),
        notes: [],
        routingEnabled: false,
      },
      flushedAt: new Date("2026-07-16T10:30:00.000Z"),
    });

    expect(item.title).toBe("rec_9876");
    expect(item.content.object.snapshotStale).toBe(true);
    expect(item.content.object.activity[0]?.attributeName).toBeUndefined();
  });

  it("keeps excess notes pending for a later flush instead of claiming them without content", () => {
    const events = [
      { id: "update_1", action: "update" as const },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `note_${index + 1}`,
        action: "note" as const,
      })),
      { id: "create_1", action: "create" as const },
    ];

    expect(selectAttioWindowEventsForFlush(events).map((event) => event.id)).toEqual([
      "update_1",
      "note_1",
      "note_2",
      "note_3",
      "note_4",
      "note_5",
      "create_1",
    ]);
  });

  it("does not route a window when enrichment invalidated the saved credential", () => {
    expect(canRouteAttioWindow("connected", false)).toBe(false);
    expect(canRouteAttioWindow("needs_reauth", true)).toBe(false);
    expect(canRouteAttioWindow("connected", true)).toBe(true);
  });

  it("does not route unnamed CRM records as raw UUID activity", () => {
    expect(hasUsableAttioRecordIdentity(null)).toBe(false);
    expect(
      hasUsableAttioRecordIdentity({
        name: null,
        url: null,
        properties: {},
      }),
    ).toBe(false);
    expect(
      hasUsableAttioRecordIdentity({
        name: "Acme renewal",
        url: null,
        properties: { name: "Acme renewal" },
      }),
    ).toBe(true);
  });

  it("keeps note content out of event subsets that did not claim the note", () => {
    const item = buildAttioObjectWindowItem({
      window,
      events: [
        {
          id: "gattevt_update_only",
          deliveryId: "updated:rec_9876:attr_stage:z",
          action: "update",
          attributeId: "attr_stage",
          noteId: null,
          payload: { actorType: "workspace-member" },
          eventTime: "2026-07-16T10:00:00.000Z",
        },
      ],
      enrichment: {
        snapshot: {
          name: "Acme renewal",
          url: null,
          properties: { name: "Acme renewal" },
        },
        attributeTitles: new Map([["attr_stage", "Stage"]]),
        notes: [
          {
            noteId: "note_for_another_brain",
            title: "Private note",
            content: "This route did not select notes.",
          },
        ],
        routingEnabled: true,
      },
      flushedAt: new Date("2026-07-16T10:30:00.000Z"),
    });

    expect(item.content.object.notes).toBeUndefined();
  });
});
