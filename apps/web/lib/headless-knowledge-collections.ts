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
const wikisById = new Map<string, ReturnType<typeof createWikiCollections>>();
const wikiImportRunsByWorkspace = new Map<
  string,
  ReturnType<typeof createWikiImportRunCollection>
>();

function shapeOptions(readModel: string, resourceId?: { brainId: string } | { wikiId: string }) {
  const query = !resourceId
    ? ""
    : "brainId" in resourceId
      ? `?brainId=${encodeURIComponent(resourceId.brainId)}`
      : `?wikiId=${encodeURIComponent(resourceId.wikiId)}`;
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
        shapeOptions: shapeOptions("brain-folders-v1", { brainId }),
        getKey: (row) => row.id,
      }),
    ),
    documents: createCollection(
      electricCollectionOptions({
        id: `headless-brain-documents:v1:${scope}`,
        schema: BrainDocumentReadModelSchema,
        shapeOptions: shapeOptions("brain-documents-v1", { brainId }),
        getKey: (row) => row.id,
      }),
    ),
    timeline: createCollection(
      electricCollectionOptions({
        id: `headless-brain-timeline:v1:${scope}`,
        schema: BrainTimelineReadModelSchema,
        shapeOptions: shapeOptions("brain-timeline-v1", { brainId }),
        getKey: (row) => row.id,
      }),
    ),
    edges: createCollection(
      electricCollectionOptions({
        id: `headless-brain-edges:v1:${scope}`,
        schema: BrainEdgeReadModelSchema,
        shapeOptions: shapeOptions("brain-edges-v1", { brainId }),
        getKey: (row) => row.id,
      }),
    ),
    ingestJobs: createCollection(
      electricCollectionOptions({
        id: `headless-brain-ingest-jobs:v1:${scope}`,
        schema: BrainIngestJobReadModelSchema,
        shapeOptions: shapeOptions("brain-ingest-jobs-v1", { brainId }),
        getKey: (row) => row.id,
      }),
    ),
    importRuns: createCollection(
      electricCollectionOptions({
        id: `headless-brain-import-runs:v1:${scope}`,
        schema: BrainImportRunReadModelSchema,
        shapeOptions: shapeOptions("brain-import-runs-v1", { brainId }),
        getKey: (row) => row.id,
      }),
    ),
  };
}

// Keyed by wiki, not workspace: a workspace can hold a restricted wiki, so the
// page and timeline shapes stream exactly one wiki and the browser never holds
// rows from a wiki the viewer is not a member of.
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

// Company import runs live on goat.brain_import_runs and are workspace-level, so
// they are not part of a wiki's collections.
function createWikiImportRunCollection(workspaceId: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-wiki-import-runs:v1:${encodeURIComponent(workspaceId)}`,
      schema: BrainImportRunReadModelSchema,
      shapeOptions: shapeOptions("wiki-import-runs-v1"),
      getKey: (row) => row.id,
    }),
  );
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

export function getHeadlessBrainCollections(brainId: string) {
  const cached = brainsById.get(brainId);
  if (cached) return cached;
  const collections = createBrainCollections(brainId);
  brainsById.set(brainId, collections);
  return collections;
}

export function getHeadlessWikiCollections(wikiId: string) {
  const cached = wikisById.get(wikiId);
  if (cached) return cached;
  const collections = createWikiCollections(wikiId);
  wikisById.set(wikiId, collections);
  return collections;
}

export function getHeadlessWikiImportRuns(workspaceId: string) {
  const cached = wikiImportRunsByWorkspace.get(workspaceId);
  if (cached) return cached;
  const collection = createWikiImportRunCollection(workspaceId);
  wikiImportRunsByWorkspace.set(workspaceId, collection);
  return collection;
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
