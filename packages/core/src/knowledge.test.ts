import { describe, expect, it, vi } from "vitest";
import type { Actor } from "./actor";
import { KnowledgeApplicationService, type KnowledgeRepository } from "./knowledge";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [
    "brain:read",
    "brain:write",
    "wiki:read",
    "wiki:write",
    "skill:read",
    "skill:write",
  ],
  authenticationMethod: "session",
};

describe("KnowledgeApplicationService", () => {
  it("authorizes the selected Brain before forwarding a normalized read", async () => {
    const assertBrainAccess = vi.fn(async () => undefined);
    const getBrainSnapshot = vi.fn(async () => ({ folders: [], documents: [] }));
    const service = new KnowledgeApplicationService(
      repository({ assertBrainAccess, getBrainSnapshot }),
    );

    await expect(service.getBrainSnapshot(actor, " brain_1 ")).resolves.toEqual({
      folders: [],
      documents: [],
    });
    expect(assertBrainAccess).toHaveBeenCalledWith({ actor, brainId: "brain_1" });
    expect(getBrainSnapshot).toHaveBeenCalledWith({ actor, brainId: "brain_1" });
  });

  it("rejects Brain writes without permission before the repository is reached", async () => {
    const assertBrainAccess = vi.fn(async () => undefined);
    const service = new KnowledgeApplicationService(repository({ assertBrainAccess }));

    await expect(
      service.createBrainDocument({ ...actor, permissions: ["brain:read"] }, "brain_1", {
        idempotencyKey: "create-1",
        folderPath: "inbox",
        fileName: "Note.md",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(assertBrainAccess).not.toHaveBeenCalled();
  });

  it("exposes the same normalized Brain write gate to canonical asset services", async () => {
    const assertBrainAccess = vi.fn(async () => undefined);
    const service = new KnowledgeApplicationService(repository({ assertBrainAccess }));

    await expect(service.authorizeBrainWrite(actor, " brain_1 ")).resolves.toBe("brain_1");
    expect(assertBrainAccess).toHaveBeenCalledWith({ actor, brainId: "brain_1" });
  });

  it("authorizes and bounds Brain source-item metadata lookups", async () => {
    const assertBrainAccess = vi.fn(async () => undefined);
    const listBrainSourceItems = vi.fn(async () => []);
    const service = new KnowledgeApplicationService(
      repository({ assertBrainAccess, listBrainSourceItems }),
    );

    await expect(
      service.listBrainSourceItems(actor, " brain_1 ", [" item_1 ", "item_1", "item_2"]),
    ).resolves.toEqual([]);
    expect(assertBrainAccess).toHaveBeenCalledWith({ actor, brainId: "brain_1" });
    expect(listBrainSourceItems).toHaveBeenCalledWith({
      actor,
      brainId: "brain_1",
      ids: ["item_1", "item_2"],
    });

    await expect(service.listBrainSourceItems(actor, "brain_1", [])).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      service.listBrainSourceItems(
        actor,
        "brain_1",
        Array.from({ length: 101 }, (_, index) => `item_${index}`),
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    await expect(
      service.listBrainSourceItems({ ...actor, permissions: [] }, "brain_1", ["item_1"]),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("uses the route id for Wiki updates and preserves empty titles", async () => {
    const updateWikiPage = vi.fn(async () => {
      throw new Error("stop after capture");
    });
    const service = new KnowledgeApplicationService(repository({ updateWikiPage }));

    await expect(
      service.updateWikiPage(actor, " page-id ", {
        body: "# Updated",
        kind: "project",
        slug: "updated-page",
        title: "",
      }),
    ).rejects.toThrow("stop after capture");
    expect(updateWikiPage).toHaveBeenCalledWith({
      actor,
      id: "page-id",
      body: "# Updated",
      kind: "project",
      slug: "updated-page",
      title: "",
    });
  });

  it("normalizes client-generated Wiki identities without accepting an empty timeline", async () => {
    const addWikiTimelineEntry = vi.fn(async () => {
      throw new Error("stop after capture");
    });
    const service = new KnowledgeApplicationService(repository({ addWikiTimelineEntry }));

    await expect(
      service.addWikiTimelineEntry(actor, {
        idempotencyKey: "timeline-1",
        clientEntryId: " entry_1 ",
        id: " page-id ",
        text: " Shipped ",
        at: "2026-08-12T08:00:00.000Z",
      }),
    ).rejects.toThrow("stop after capture");
    expect(addWikiTimelineEntry).toHaveBeenCalledWith({
      actor,
      idempotencyKey: "timeline-1",
      clientEntryId: "entry_1",
      id: "page-id",
      text: "Shipped",
      at: new Date("2026-08-12T08:00:00.000Z"),
    });
  });
});

function repository(overrides: Partial<KnowledgeRepository>): KnowledgeRepository {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return async () => {
        throw new Error(`Unexpected repository operation: ${String(property)}.`);
      };
    },
  }) as KnowledgeRepository;
}
