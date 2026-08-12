"use client";

import { parentWikiPath } from "@opencompany/goat-wiki";
import {
  type BrainDocumentReadModel,
  BrainDocumentReadModelSchema,
  type BrainEdgeReadModel,
  BrainEdgeReadModelSchema,
  type BrainFolderReadModel,
  BrainFolderReadModelSchema,
  type BrainTimelineReadModel,
  BrainTimelineReadModelSchema,
  type WikiPageReadModel,
  WikiPageReadModelSchema,
  type WikiTimelineReadModel,
  WikiTimelineReadModelSchema,
} from "@opencompany/protocol";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import {
  addWikiTimelineEntryRequest,
  createWikiPageRequest,
  deleteWikiPageRequest,
  updateWikiPageRequest,
} from "./headless-knowledge-wiki-api";

const brainsById = new Map<string, ReturnType<typeof createBrainCollections>>();
const wikisByScope = new Map<string, ReturnType<typeof createWikiCollections>>();

function shapeOptions(readModel: string, brainId?: string) {
  const query = brainId ? `?brainId=${encodeURIComponent(brainId)}` : "";
  return {
    url: `${headlessChatApiBaseUrl()}/v1/read-models/${readModel}${query}`,
    fetchClient: createHeadlessChatApiFetch(),
  };
}

function createBrainCollections(brainId: string) {
  const scope = encodeURIComponent(brainId);
  return {
    folders: createCollection(
      electricCollectionOptions({
        id: `headless-brain-folders:v1:${scope}`,
        schema: BrainFolderReadModelSchema,
        shapeOptions: shapeOptions("brain-folders-v1", brainId),
        getKey: (row) => row.id,
      }),
    ),
    documents: createCollection(
      electricCollectionOptions({
        id: `headless-brain-documents:v1:${scope}`,
        schema: BrainDocumentReadModelSchema,
        shapeOptions: shapeOptions("brain-documents-v1", brainId),
        getKey: (row) => row.id,
      }),
    ),
    timeline: createCollection(
      electricCollectionOptions({
        id: `headless-brain-timeline:v1:${scope}`,
        schema: BrainTimelineReadModelSchema,
        shapeOptions: shapeOptions("brain-timeline-v1", brainId),
        getKey: (row) => row.id,
      }),
    ),
    edges: createCollection(
      electricCollectionOptions({
        id: `headless-brain-edges:v1:${scope}`,
        schema: BrainEdgeReadModelSchema,
        shapeOptions: shapeOptions("brain-edges-v1", brainId),
        getKey: (row) => row.id,
      }),
    ),
  };
}

function createWikiCollections(scopeKey: string) {
  const scope = encodeURIComponent(scopeKey);
  const pages = createCollection(
    electricCollectionOptions({
      id: `headless-wiki-pages:v1:${scope}`,
      schema: WikiPageReadModelSchema,
      shapeOptions: shapeOptions("wiki-pages-v1"),
      getKey: (row) => row.id,
      onInsert: async ({ transaction }) => {
        const transactionIds: number[] = [];
        for (const mutation of transaction.mutations) {
          const row = mutation.modified;
          const result = await createWikiPageRequest({
            clientPageId: row.id,
            slug: row.slug,
            parentPath: parentWikiPath(row.path),
            title: row.title,
          });
          transactionIds.push(...result.transactionIds);
        }
        return { txid: transactionIds };
      },
      onUpdate: async ({ transaction }) => ({
        txid: await persistHeadlessWikiPageWrites(
          asHeadlessWikiPageWriteMutations(transaction.mutations),
        ),
      }),
      onDelete: async ({ transaction }) => {
        const transactionIds: number[] = [];
        for (const root of wikiDeleteRoots(transaction.mutations)) {
          const result = await deleteWikiPageRequest(root.slug, { recursive: true });
          transactionIds.push(...result.transactionIds);
        }
        return { txid: transactionIds };
      },
    }),
  );
  const timeline = createCollection(
    electricCollectionOptions({
      id: `headless-wiki-timeline:v1:${scope}`,
      schema: WikiTimelineReadModelSchema,
      shapeOptions: shapeOptions("wiki-timeline-v1"),
      getKey: (row) => row.id,
      onInsert: async ({ transaction }) => {
        const transactionIds: number[] = [];
        for (const mutation of transaction.mutations) {
          const row = mutation.modified;
          const slug = pages.get(row.pageId)?.slug;
          if (!slug) throw new Error("Cannot add a timeline entry to an unknown page.");
          const result = await addWikiTimelineEntryRequest(slug, {
            clientEntryId: row.id,
            text: row.text,
            at: row.at,
          });
          transactionIds.push(result.transactionId);
        }
        return { txid: transactionIds };
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
) {
  const transactionIds: number[] = [];
  for (const mutation of mutations) {
    const result = await chainWikiPageWrite(mutation.original.id, () =>
      updateWikiPageRequest(mutation.original.slug, {
        body: mutation.modified.body,
        kind: mutation.modified.kind,
        title: mutation.modified.title,
      }),
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

export function getHeadlessBrainCollections(brainId: string) {
  const cached = brainsById.get(brainId);
  if (cached) return cached;
  const collections = createBrainCollections(brainId);
  brainsById.set(brainId, collections);
  return collections;
}

export function getHeadlessWikiCollections(scopeKey = "active") {
  const cached = wikisByScope.get(scopeKey);
  if (cached) return cached;
  const collections = createWikiCollections(scopeKey);
  wikisByScope.set(scopeKey, collections);
  return collections;
}

export type HeadlessWikiCollections = ReturnType<typeof createWikiCollections>;

export async function awaitHeadlessWikiTransactions(
  transactionIds: number[],
  options: { scopeKey?: string; target?: "pages" | "timeline"; timeoutMs?: number } = {},
) {
  const pendingIds = transactionIds.filter(
    (transactionId) => Number.isSafeInteger(transactionId) && transactionId > 0,
  );
  if (pendingIds.length === 0) return;
  const collection = getHeadlessWikiCollections(options.scopeKey)[options.target ?? "pages"];
  await Promise.all(
    pendingIds.map((transactionId) => collection.utils.awaitTxId(transactionId, options.timeoutMs)),
  );
}

export type HeadlessBrainFolderReadModel = BrainFolderReadModel;
export type HeadlessBrainDocumentReadModel = BrainDocumentReadModel;
export type HeadlessBrainTimelineReadModel = BrainTimelineReadModel;
export type HeadlessBrainEdgeReadModel = BrainEdgeReadModel;
export type HeadlessWikiPageReadModel = WikiPageReadModel;
export type HeadlessWikiTimelineReadModel = WikiTimelineReadModel;
