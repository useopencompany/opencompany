import { createCollection } from "@tanstack/react-db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitHeadlessWikiTransactions,
  getHeadlessBrainCollections,
  getHeadlessWikiCollections,
  persistHeadlessWikiPageWrites,
} from "./headless-knowledge-collections";
import { updateWikiPageRequest } from "./headless-knowledge-wiki-api";

vi.mock("@tanstack/electric-db-collection", () => ({
  electricCollectionOptions: vi.fn((options) => options),
}));

vi.mock("@tanstack/react-db", () => ({
  createCollection: vi.fn((options) => ({
    options,
    utils: { awaitTxId: vi.fn(async () => undefined) },
  })),
}));

vi.mock("./headless-chat-api", () => ({
  createHeadlessChatApiFetch: vi.fn(() => fetch),
  headlessChatApiBaseUrl: vi.fn(() => "https://api.example.test"),
}));

vi.mock("./headless-knowledge-wiki-api", () => ({
  addWikiTimelineEntryRequest: vi.fn(),
  createWikiPageRequest: vi.fn(),
  deleteWikiPageRequest: vi.fn(),
  updateWikiPageRequest: vi.fn(),
}));

type TestCollection = {
  options: { id: string; shapeOptions: { url: string } };
  utils: { awaitTxId: ReturnType<typeof vi.fn> };
};

const wikiPage = {
  id: "wiki_page_1",
  slug: "launch-plan",
  path: "Launch Plan",
  title: "Launch Plan",
  kind: "project" as const,
  body: "Plan",
  contentHash: "a".repeat(64),
  sizeBytes: 4,
  format: "markdown",
  mimeType: "text/markdown",
  originalFileName: null,
  assetSizeBytes: null,
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: "2026-08-12T08:00:00.000Z",
};

describe("headless knowledge collections", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses versioned API-owned Brain shapes scoped by the authorized Brain", () => {
    const first = getHeadlessBrainCollections("brain_alpha");
    const second = getHeadlessBrainCollections("brain_alpha");

    expect(first).toBe(second);
    expect(createCollection).toHaveBeenCalledTimes(4);
    expect((first.documents as unknown as TestCollection).options).toMatchObject({
      id: "headless-brain-documents:v1:brain_alpha",
      shapeOptions: {
        url: "https://api.example.test/v1/read-models/brain-documents-v1?brainId=brain_alpha",
      },
    });
    expect((first.edges as unknown as TestCollection).options.shapeOptions.url).toBe(
      "https://api.example.test/v1/read-models/brain-edges-v1?brainId=brain_alpha",
    );
  });

  it("uses fixed workspace-authorized Wiki shapes without caller predicates", () => {
    const wiki = getHeadlessWikiCollections("workspace_knowledge");

    expect((wiki.pages as unknown as TestCollection).options).toMatchObject({
      id: "headless-wiki-pages:v1:workspace_knowledge",
      shapeOptions: { url: "https://api.example.test/v1/read-models/wiki-pages-v1" },
    });
    expect((wiki.timeline as unknown as TestCollection).options.shapeOptions.url).toBe(
      "https://api.example.test/v1/read-models/wiki-timeline-v1",
    );
  });

  it("serializes writes to the same Wiki page and preserves canonical transaction ids", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(updateWikiPageRequest)
      .mockImplementationOnce(async () => {
        await firstPending;
        return { page: wikiPage, transactionIds: [81] };
      })
      .mockResolvedValueOnce({ page: wikiPage, transactionIds: [82] });

    const first = persistHeadlessWikiPageWrites([
      { original: wikiPage, modified: { ...wikiPage, body: "First" } },
    ]);
    const second = persistHeadlessWikiPageWrites([
      { original: wikiPage, modified: { ...wikiPage, body: "Second" } },
    ]);

    await vi.waitFor(() => expect(updateWikiPageRequest).toHaveBeenCalledTimes(1));
    releaseFirst?.();

    await expect(first).resolves.toEqual([81]);
    await expect(second).resolves.toEqual([82]);
    expect(updateWikiPageRequest).toHaveBeenNthCalledWith(2, "launch-plan", {
      body: "Second",
      kind: "project",
      title: "Launch Plan",
    });
  });

  it("waits only for positive safe Wiki transaction ids", async () => {
    const wiki = getHeadlessWikiCollections("workspace_wait");

    await awaitHeadlessWikiTransactions([0, -1, Number.NaN, 91], {
      scopeKey: "workspace_wait",
      timeoutMs: 5_000,
    });

    expect(wiki.pages.utils.awaitTxId).toHaveBeenCalledTimes(1);
    expect(wiki.pages.utils.awaitTxId).toHaveBeenCalledWith(91, 5_000);
  });
});
