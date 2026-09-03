"use client";

import {
  type BrainDocumentReadModel,
  BrainDocumentReadModelSchema,
  type BrainEdgeReadModel,
  BrainEdgeReadModelSchema,
  type BrainFolderReadModel,
  BrainFolderReadModelSchema,
  type BrainImportProviderSummary,
  BrainImportRunReadModelSchema,
  type BrainImportRunStatus,
  BrainIngestJobReadModelSchema,
  type BrainTimelineReadModel,
  BrainTimelineReadModelSchema,
  type WikiPageReadModel,
  WikiPageReadModelSchema,
  type WikiTimelineReadModel,
  WikiTimelineReadModelSchema,
} from "@opencompany/protocol";
import { parentWikiPath } from "@opencompany/wiki";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import { reconcileCommittedProjection } from "./headless-collection-reconciliation";
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
    ingestJobs: createCollection(
      electricCollectionOptions({
        id: `headless-brain-ingest-jobs:v1:${scope}`,
        schema: BrainIngestJobReadModelSchema,
        shapeOptions: shapeOptions("brain-ingest-jobs-v1", brainId),
        getKey: (row) => row.id,
      }),
    ),
    importRuns: createCollection(
      electricCollectionOptions({
        id: `headless-brain-import-runs:v1:${scope}`,
        schema: BrainImportRunReadModelSchema,
        shapeOptions: shapeOptions("brain-import-runs-v1", brainId),
        getKey: (row) => row.id,
      }),
    ),
  };
}

function createWikiCollections(scopeKey: string) {
  const scope = encodeURIComponent(scopeKey);
  const pages = createCollection(
    electricCollectionOptions({
      id: `headless-wiki-pages:v2:${scope}`,
      schema: WikiPageReadModelSchema,
      shapeOptions: shapeOptions("wiki-pages-v2"),
      getKey: (row) => row.id,
      onInsert: async ({ transaction }) => {
        const transactionIds: number[] = [];
        for (const mutation of transaction.mutations) {
          const row = mutation.modified;
          const result = await createWikiPageRequest({
            clientPageId: row.id,
            nodeType: row.nodeType,
            slug: row.slug,
            parentPath: parentWikiPath(row.path),
            title: row.title,
          });
          transactionIds.push(...result.transactionIds);
        }
        await awaitHeadlessWikiTransactions(transactionIds, { scopeKey });
      },
      onUpdate: async ({ transaction }) => {
        const transactionIds = await persistHeadlessWikiPageWrites(
          asHeadlessWikiPageWriteMutations(transaction.mutations),
        );
        await awaitHeadlessWikiTransactions(transactionIds, { scopeKey });
      },
      onDelete: async ({ transaction }) => {
        const transactionIds: number[] = [];
        for (const root of wikiDeleteRoots(transaction.mutations)) {
          const result = await deleteWikiPageRequest(root.id, { recursive: true });
          transactionIds.push(...result.transactionIds);
        }
        await awaitHeadlessWikiTransactions(transactionIds, { scopeKey });
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
          const page = pages.get(row.pageId);
          if (!page || page.nodeType !== "page") {
            throw new Error("Cannot add a timeline entry to an unknown page.");
          }
          const result = await addWikiTimelineEntryRequest(page.id, {
            clientEntryId: row.id,
            text: row.text,
            at: row.at,
          });
          transactionIds.push(result.transactionId);
        }
        await awaitHeadlessWikiTransactions(transactionIds, { scopeKey, target: "timeline" });
      },
    }),
  );
  const importRuns = createCollection(
    electricCollectionOptions({
      id: `headless-wiki-import-runs:v1:${scope}`,
      schema: BrainImportRunReadModelSchema,
      shapeOptions: shapeOptions("wiki-import-runs-v1"),
      getKey: (row) => row.id,
    }),
  );
  return { pages, timeline, importRuns };
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
      updateWikiPageRequest(
        mutation.original.id,
        mutation.original.nodeType === "folder"
          ? {
              ...(mutation.modified.slug !== mutation.original.slug
                ? { slug: mutation.modified.slug }
                : {}),
              title: mutation.modified.title,
            }
          : {
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

export function getHeadlessBrainCollections(brainId: string) {
  const cached = brainsById.get(brainId);
  if (cached) return cached;
  const collections = createBrainCollections(brainId);
  brainsById.set(brainId, collections);
  return collections;
}

export function getHeadlessWikiCollections(scopeKey: string) {
  const cached = wikisByScope.get(scopeKey);
  if (cached) return cached;
  const collections = createWikiCollections(scopeKey);
  wikisByScope.set(scopeKey, collections);
  return collections;
}

export type HeadlessWikiCollections = ReturnType<typeof createWikiCollections>;
export async function awaitHeadlessWikiTransactions(
  transactionIds: number[],
  options: { scopeKey: string; target?: "pages" | "timeline"; timeoutMs?: number },
) {
  const pendingIds = transactionIds.filter(
    (transactionId) => Number.isSafeInteger(transactionId) && transactionId > 0,
  );
  if (pendingIds.length === 0) return;
  const collection = getHeadlessWikiCollections(options.scopeKey)[options.target ?? "pages"];
  await Promise.all(
    pendingIds.map((transactionId) =>
      reconcileCommittedProjection(collection.utils.awaitTxId(transactionId, options.timeoutMs)),
    ),
  );
}

export type HeadlessBrainFolderReadModel = BrainFolderReadModel;
export type HeadlessBrainDocumentReadModel = BrainDocumentReadModel;
export type HeadlessBrainTimelineReadModel = BrainTimelineReadModel;
export type HeadlessBrainEdgeReadModel = BrainEdgeReadModel;
// Spelled out instead of z.infer because the protocol's OpenAPI-wrapped record schemas lose
// their value types when inferred across the package boundary in this app's TS setup.
export type HeadlessBrainImportRunReadModel = {
  id: string;
  status: BrainImportRunStatus;
  companyUrl: string;
  companyName: string | null;
  focus: string | null;
  sourceSelection: Record<string, { enabled: boolean }>;
  discoverySummary: Record<string, BrainImportProviderSummary>;
  lastError: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type HeadlessWikiImportRunReadModel = HeadlessBrainImportRunReadModel;
export type HeadlessWikiPageReadModel = WikiPageReadModel;
export type HeadlessWikiTimelineReadModel = WikiTimelineReadModel;
