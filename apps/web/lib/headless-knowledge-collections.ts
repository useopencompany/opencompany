"use client";

import {
  type WikiPageReadModel,
  WikiPageReadModelSchema,
  type WikiTimelineReadModel,
  WikiTimelineReadModelSchema,
} from "@opencompany/protocol";
import { parentWikiPath } from "@opencompany/wiki";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import {
  awaitCollectionTransaction,
  reconcileCommittedProjection,
} from "./headless-collection-reconciliation";
import {
  addWikiTimelineEntryRequest,
  createWikiPageRequest,
  deleteWikiPageRequest,
  updateWikiPageRequest,
} from "./headless-knowledge-wiki-api";

const wikisById = new Map<string, ReturnType<typeof createWikiCollections>>();
function shapeOptions(readModel: string, resourceId?: { wikiId: string }) {
  const query = resourceId ? `?wikiId=${encodeURIComponent(resourceId.wikiId)}` : "";
  return {
    url: `${headlessChatApiBaseUrl()}/v1/read-models/${readModel}${query}`,
    fetchClient: createHeadlessChatApiFetch(),
  };
}

function createWikiCollections(wikiId: string) {
  const scope = encodeURIComponent(wikiId);
  const pages = createCollection(
    electricCollectionOptions({
      id: `headless-wiki-pages:v2:${scope}`,
      schema: WikiPageReadModelSchema,
      shapeOptions: shapeOptions("wiki-pages-v2", { wikiId }),
      getKey: (row) => row.id,
      onInsert: async ({ transaction }) => {
        const transactionIds: number[] = [];
        for (const mutation of transaction.mutations) {
          const row = mutation.modified;
          const result = await createWikiPageRequest({
            wikiId,
            clientPageId: row.id,
            nodeType: row.nodeType,
            slug: row.slug,
            parentPath: parentWikiPath(row.path),
            title: row.title,
          });
          transactionIds.push(...result.transactionIds);
        }
        await awaitHeadlessWikiTransactions(transactionIds, { wikiId });
      },
      onUpdate: async ({ transaction }) => {
        const transactionIds = await persistHeadlessWikiPageWrites(
          asHeadlessWikiPageWriteMutations(transaction.mutations),
          wikiId,
        );
        await awaitHeadlessWikiTransactions(transactionIds, { wikiId });
      },
      onDelete: async ({ transaction }) => {
        const transactionIds: number[] = [];
        for (const root of wikiDeleteRoots(transaction.mutations)) {
          const result = await deleteWikiPageRequest(root.id, { wikiId, recursive: true });
          transactionIds.push(...result.transactionIds);
        }
        await awaitHeadlessWikiTransactions(transactionIds, { wikiId });
      },
    }),
  );
  const timeline = createCollection(
    electricCollectionOptions({
      id: `headless-wiki-timeline:v1:${scope}`,
      schema: WikiTimelineReadModelSchema,
      shapeOptions: shapeOptions("wiki-timeline-v1", { wikiId }),
      getKey: (row) => row.id,
      onInsert: async ({ transaction }) => {
        const transactionIds: number[] = [];
        for (const mutation of transaction.mutations) {
          const row = mutation.modified;
          const page = pages.get(row.pageId);
          if (!page || page.nodeType !== "page") {
            throw new Error("Cannot add a timeline entry to an unknown page.");
          }
          const result = await addWikiTimelineEntryRequest(page.id, {
            wikiId,
            clientEntryId: row.id,
            text: row.text,
            at: row.at,
          });
          transactionIds.push(result.transactionId);
        }
        await awaitHeadlessWikiTransactions(transactionIds, { wikiId, target: "timeline" });
      },
    }),
  );
  return { pages, timeline };
}

const wikiPageWriteChains = new Map<string, Promise<unknown>>();

function chainWikiPageWrite<T>(pageId: string, write: () => Promise<T>): Promise<T> {
  const chained = (wikiPageWriteChains.get(pageId) ?? Promise.resolve()).then(write, write);
  wikiPageWriteChains.set(
    pageId,
    chained.catch(() => undefined),
  );
  return chained;
}

export type HeadlessWikiPageWriteMutation = {
  original: WikiPageReadModel;
  modified: WikiPageReadModel;
};

export function asHeadlessWikiPageWriteMutations(
  mutations: ReadonlyArray<{ original: unknown; modified: unknown }>,
): HeadlessWikiPageWriteMutation[] {
  return mutations.map((mutation) => ({
    original: mutation.original as WikiPageReadModel,
    modified: mutation.modified as WikiPageReadModel,
  }));
}

export async function persistHeadlessWikiPageWrites(
  mutations: ReadonlyArray<HeadlessWikiPageWriteMutation>,
  wikiId: string,
) {
  const transactionIds: number[] = [];
  for (const mutation of mutations) {
    const result = await chainWikiPageWrite(mutation.original.id, () =>
      updateWikiPageRequest(
        mutation.original.id,
        mutation.original.nodeType === "folder"
          ? {
              wikiId,
              ...(mutation.modified.slug !== mutation.original.slug
                ? { slug: mutation.modified.slug }
                : {}),
              title: mutation.modified.title,
            }
          : {
              wikiId,
              body: mutation.modified.body,
              kind: mutation.modified.kind,
              ...(mutation.modified.slug !== mutation.original.slug
                ? { slug: mutation.modified.slug }
                : {}),
              title: mutation.modified.title,
            },
      ),
    );
    transactionIds.push(...result.transactionIds);
  }
  return transactionIds;
}

function wikiDeleteRoots(mutations: Array<{ original: WikiPageReadModel }>): WikiPageReadModel[] {
  const paths = new Set(mutations.map((mutation) => mutation.original.path));
  return mutations
    .map((mutation) => mutation.original)
    .filter((row) => {
      for (let parent = parentWikiPath(row.path); parent; parent = parentWikiPath(parent)) {
        if (paths.has(parent)) return false;
      }
      return true;
    });
}

export function getHeadlessWikiCollections(wikiId: string) {
  const cached = wikisById.get(wikiId);
  if (cached) return cached;
  const collections = createWikiCollections(wikiId);
  wikisById.set(wikiId, collections);
  return collections;
}

export type HeadlessWikiCollections = ReturnType<typeof createWikiCollections>;
export async function awaitHeadlessWikiTransactions(
  transactionIds: number[],
  options: { wikiId: string; target?: "pages" | "timeline"; timeoutMs?: number },
) {
  const pendingIds = transactionIds.filter(
    (transactionId) => Number.isSafeInteger(transactionId) && transactionId > 0,
  );
  if (pendingIds.length === 0) return;
  const collection = getHeadlessWikiCollections(options.wikiId)[options.target ?? "pages"];
  await Promise.all(
    pendingIds.map((transactionId) =>
      reconcileCommittedProjection(
        awaitCollectionTransaction(collection, transactionId, options.timeoutMs),
      ),
    ),
  );
}

export type HeadlessWikiPageReadModel = WikiPageReadModel;
export type HeadlessWikiTimelineReadModel = WikiTimelineReadModel;
