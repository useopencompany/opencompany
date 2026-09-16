import { describe, expect, it, vi } from "vitest";
import type { Actor } from "./actor";
import { KnowledgeApplicationService, type KnowledgeRepository } from "./knowledge";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["wiki:read", "wiki:write", "skill:read", "skill:write"],
  authenticationMethod: "session",
};

describe("KnowledgeApplicationService", () => {
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
      wikiId: "goat_wiki_1",
      id: "page-id",
      body: "# Updated",
      kind: "project",
      slug: "updated-page",
      title: "",
    });
  });

  it("resolves Wiki writes against the selected wiki", async () => {
    const resolveWiki = vi.fn(async () => ({
      wikiId: "goat_wiki_clevel",
      name: "C-level",
      slug: "c-level",
      instructions: "",
    }));
    const updateWikiPage = vi.fn(async () => {
      throw new Error("stop after capture");
    });
    const service = new KnowledgeApplicationService(repository({ resolveWiki, updateWikiPage }));

    await expect(
      service.updateWikiPage(actor, "page-id", { wikiId: " goat_wiki_clevel ", body: "# Board" }),
    ).rejects.toThrow("stop after capture");
    expect(resolveWiki).toHaveBeenCalledWith({ actor, wikiId: "goat_wiki_clevel" });
    expect(updateWikiPage).toHaveBeenCalledWith({
      actor,
      wikiId: "goat_wiki_clevel",
      id: "page-id",
      body: "# Board",
    });
  });

  it("reports an unreachable Wiki as not_found without touching page storage", async () => {
    const updateWikiPage = vi.fn(async () => {
      throw new Error("should not be reached");
    });
    const service = new KnowledgeApplicationService(
      repository({ resolveWiki: async () => null, updateWikiPage }),
    );

    await expect(
      service.updateWikiPage(actor, "page-id", { wikiId: "goat_wiki_other", body: "# Board" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(updateWikiPage).not.toHaveBeenCalled();
  });

  it("rejects Wiki writes without permission before resolving the wiki", async () => {
    const resolveWiki = vi.fn(async () => defaultWiki);
    const service = new KnowledgeApplicationService(repository({ resolveWiki }));

    await expect(
      service.updateWikiPage({ ...actor, permissions: ["wiki:read"] }, "page-id", {
        body: "# Board",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(resolveWiki).not.toHaveBeenCalled();
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
      wikiId: "goat_wiki_1",
      idempotencyKey: "timeline-1",
      clientEntryId: "entry_1",
      id: "page-id",
      text: "Shipped",
      at: new Date("2026-08-12T08:00:00.000Z"),
    });
  });
});

const defaultWiki = {
  wikiId: "goat_wiki_1",
  name: "Wiki",
  slug: "wiki",
  instructions: "",
};

function repository(overrides: Partial<KnowledgeRepository>): KnowledgeRepository {
  return new Proxy(
    { resolveWiki: async () => defaultWiki, ...overrides },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        return async () => {
          throw new Error(`Unexpected repository operation: ${String(property)}.`);
        };
      },
    },
  ) as KnowledgeRepository;
}
