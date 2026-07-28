import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConnection: vi.fn(),
}));

vi.mock("@opencompany/goat-agent/integrations/kleinanzeigen", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@opencompany/goat-agent/integrations/kleinanzeigen")>();
  return {
    ...actual,
    loadGoatKleinanzeigenConnection: mocks.loadConnection,
  };
});

import {
  buildKleinanzeigenListingTask,
  normalizeKleinanzeigenListingInput,
  resolveKleinanzeigenActions,
} from "@/lib/actions/kleinanzeigen";

const connection = {
  integrationId: "gint_kleinanzeigen",
  userWorkosId: "user_1",
  accountName: "Browser Use",
  capabilityModes: {},
  apiKey: "browser-use-key-1234567890",
  projectId: "f7d44c26-f2d4-4a73-907d-76ad11340e14",
  profileId: "1cb05392-07af-431e-bc73-5018880ece7b",
  browserWorkspaceId: "d3793d62-d4ca-4f3d-8747-8e634208b811",
  connectedAt: "2026-07-28T00:00:00.000Z",
};

beforeEach(() => {
  mocks.loadConnection.mockReset();
  mocks.loadConnection.mockResolvedValue(connection);
});

describe("Kleinanzeigen chat actions", () => {
  it("requires approval for publish and continuation while status remains read-only", async () => {
    const catalog = await resolveKleinanzeigenActions("user_1");
    expect(catalog?.actions.map((action) => [action.id, action.permissionMode])).toEqual([
      ["kleinanzeigen.create_listing", "ask"],
      ["kleinanzeigen.continue_listing", "ask"],
      ["kleinanzeigen.get_listing_status", "on"],
    ]);
    expect(catalog?.actions[0]?.permission).toMatchObject({
      capabilityId: "write",
      label: "Publish this exact Kleinanzeigen listing",
      integrationIds: ["gint_kleinanzeigen"],
    });
  });

  it("removes publishing actions when the user turns the permission off", async () => {
    mocks.loadConnection.mockResolvedValue({
      ...connection,
      capabilityModes: { write: "off" },
    });
    const catalog = await resolveKleinanzeigenActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "kleinanzeigen.get_listing_status",
    ]);
  });

  it("rejects incomplete listing details before starting a browser run", async () => {
    const catalog = await resolveKleinanzeigenActions("user_1");
    const create = catalog?.actions.find((action) => action.id === "kleinanzeigen.create_listing");
    await expect(
      create?.execute(
        {
          title: "Too short",
          description: "A truthful description",
          category: "Home & Garden",
          priceType: "fixed",
          priceEur: 25,
          attachmentIds: ["attachment_1"],
        },
        {
          userWorkosId: "user_1",
          workspaceId: "workspace_1",
          chatSessionId: "chat_1",
          toolCallId: "call_1",
          signal: new AbortController().signal,
          currentDate: new Date("2026-07-28T00:00:00.000Z"),
          userTimezone: "Europe/Berlin",
        },
      ),
    ).rejects.toThrow('"title" must be 10–65 characters.');
  });

  it("binds exact listing data and the fee, credential, and CAPTCHA stops into the task", () => {
    const listing = normalizeKleinanzeigenListingInput({
      title: "Massiver Holzstuhl in gutem Zustand",
      description: "Gebrauchter Holzstuhl mit normalen Gebrauchsspuren.",
      category: "Haus & Garten > Möbel > Stühle",
      priceType: "negotiable",
      priceEur: 25,
      condition: "Gut",
      shipping: "Nur Abholung",
      postalCode: "10115",
      attachmentIds: ["attachment_1"],
    });
    const task = buildKleinanzeigenListingTask(listing, ["listings/run/01-chair.webp"]);
    expect(task).toContain('"title": "Massiver Holzstuhl in gutem Zustand"');
    expect(task).toContain('"imagePaths": [');
    expect(task).toContain("Never enter or request credentials");
    expect(task).toContain("Never bypass CAPTCHA");
    expect(task).toContain("Never accept a fee");
    expect(task).toContain("Kleinanzeigen charges €0");
  });
});
