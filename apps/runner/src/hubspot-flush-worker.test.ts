import { normalizeHubspotObjectWindow } from "@opencompany/brain";
import { describe, expect, it } from "vitest";
import {
  buildHubspotObjectWindowItem,
  classifyHubspotObjectWindowForIngest,
} from "./hubspot-flush-worker";

function hubspotObjectWindow(
  activity: Parameters<typeof normalizeHubspotObjectWindow>[0]["activity"],
  overrides: Partial<Parameters<typeof normalizeHubspotObjectWindow>[0]> = {},
) {
  return normalizeHubspotObjectWindow({
    windowId: "ghubwin_test",
    portalId: "62515",
    objectType: "deal",
    objectId: "9876",
    name: "Acme renewal",
    stage: "closedwon",
    activity,
    flushedAt: "2026-07-16T10:15:00.000Z",
    ...overrides,
  });
}

describe("classifyHubspotObjectWindowForIngest", () => {
  it("skips windows made only of routine bookkeeping updates", () => {
    const item = hubspotObjectWindow([
      {
        occurredAt: "2026-07-16T10:00:00.000Z",
        action: "update",
        propertyName: "hubspot_owner_id",
      },
      {
        occurredAt: "2026-07-16T10:01:00.000Z",
        action: "update",
        propertyName: "num_associated_contacts",
      },
    ]);

    expect(classifyHubspotObjectWindowForIngest(item)).toEqual({
      action: "skip",
      reason: "routine_hubspot_property_update",
    });
  });

  it("ingests record creation", () => {
    const item = hubspotObjectWindow([
      { occurredAt: "2026-07-16T10:00:00.000Z", action: "create" },
    ]);

    expect(classifyHubspotObjectWindowForIngest(item)).toEqual({ action: "ingest" });
  });

  it("ingests substantive property changes mixed with routine ones", () => {
    const item = hubspotObjectWindow([
      {
        occurredAt: "2026-07-16T10:00:00.000Z",
        action: "update",
        propertyName: "hubspot_owner_id",
      },
      {
        occurredAt: "2026-07-16T10:01:00.000Z",
        action: "update",
        propertyName: "dealstage",
        propertyValue: "closedwon",
      },
    ]);

    expect(classifyHubspotObjectWindowForIngest(item)).toEqual({ action: "ingest" });
  });

  it("ingests updates without a property name", () => {
    const item = hubspotObjectWindow([
      { occurredAt: "2026-07-16T10:00:00.000Z", action: "update" },
    ]);

    expect(classifyHubspotObjectWindowForIngest(item)).toEqual({ action: "ingest" });
  });
});

describe("buildHubspotObjectWindowItem", () => {
  const window = {
    integrationId: "gint_hubspot_1",
    userWorkosId: "user_1",
    portalId: "62515",
    objectType: "deal" as const,
    objectId: "9876",
  };

  it("builds a snapshot-enriched window item", () => {
    const item = buildHubspotObjectWindowItem({
      window,
      events: [
        {
          id: "ghubevt_1",
          deliveryId: "100:deal.propertyChange",
          action: "update",
          propertyName: "dealstage",
          payload: { propertyValue: "closedwon", changeSource: "CRM_UI" },
          eventTime: "2026-07-16T10:00:00.000Z",
        },
      ],
      snapshot: {
        name: "Acme renewal",
        url: "https://app.hubspot.com/contacts/62515/record/0-3/9876",
        properties: { dealname: "Acme renewal", dealstage: "closedwon", amount: "12000" },
        stage: "closedwon",
        amount: "12000",
        associatedCompanies: ["Acme Inc"],
      },
      flushedAt: new Date("2026-07-16T10:30:00.000Z"),
    });

    expect(item.sourceProvider).toBe("hubspot");
    expect(item.sourceType).toBe("activity");
    expect(item.sourceRef).toBe("hubspot:62515:deal:9876");
    expect(item.title).toBe("Acme renewal");
    expect(item.content.object.stage).toBe("closedwon");
    expect(item.content.object.associatedCompanies).toEqual(["Acme Inc"]);
    expect(item.content.object.activity[0]).toMatchObject({
      action: "update",
      propertyName: "dealstage",
      propertyValue: "closedwon",
      changeSource: "CRM_UI",
    });
  });

  it("falls back to buffered name properties when the snapshot is unavailable", () => {
    const item = buildHubspotObjectWindowItem({
      window: { ...window, objectType: "contact" as const, objectId: "555" },
      events: [
        {
          id: "ghubevt_2",
          deliveryId: "101:contact.propertyChange",
          action: "update",
          propertyName: "firstname",
          payload: { propertyValue: "Jane" },
          eventTime: "2026-07-16T10:00:00.000Z",
        },
        {
          id: "ghubevt_3",
          deliveryId: "102:contact.propertyChange",
          action: "update",
          propertyName: "lastname",
          payload: { propertyValue: "Doe" },
          eventTime: "2026-07-16T10:01:00.000Z",
        },
      ],
      snapshot: null,
      flushedAt: new Date("2026-07-16T10:30:00.000Z"),
    });

    expect(item.title).toBe("Jane Doe");
    expect(item.sourceRef).toBe("hubspot:62515:contact:555");
    expect(item.content.object.snapshotStale).toBe(true);
  });

  it("falls back to the object id when nothing carries a name", () => {
    const item = buildHubspotObjectWindowItem({
      window,
      events: [
        {
          id: "ghubevt_4",
          deliveryId: "103:deal.propertyChange",
          action: "update",
          propertyName: "amount",
          payload: { propertyValue: "500" },
          eventTime: "2026-07-16T10:00:00.000Z",
        },
      ],
      snapshot: null,
      flushedAt: new Date("2026-07-16T10:30:00.000Z"),
    });

    expect(item.title).toBe("9876");
  });
});
