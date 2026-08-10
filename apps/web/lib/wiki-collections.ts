import type { WikiKind } from "@opencompany/goat-wiki";
import { parentWikiPath } from "@opencompany/goat-wiki";
import { createGoatElectricCollection } from "@/lib/electric-collection";
import {
  addWikiTimelineEntryAction,
  createWikiPageAction,
  deleteWikiPageAction,
  saveWikiPageAction,
} from "@/lib/wiki-actions";

// Electric-synced collections behind the wiki surface. The UI mutates these
// optimistically (every edit is visible instantly, everywhere in the tree) and
// the handlers persist through the same server actions/storage layer the
// `wiki` agent tool uses. Handlers return Postgres txids so optimistic state
// holds exactly until the write streams back — no flicker, no manual
// reconciliation.

export type GoatWikiPageRow = {
  id: string;
  workspace_id: string;
  slug: string;
  path: string;
  title: string;
  kind: WikiKind;
  content: string;
  content_hash: string;
  size_bytes: number;
  format: string;
  mime_type: string | null;
  original_file_name: string | null;
  asset_storage_key: string | null;
  asset_content_hash: string | null;
  asset_size_bytes: number | null;
  created_by_workos_id: string | null;
  updated_by_workos_id: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatWikiTimelineEntryRow = {
  id: string;
  workspace_id: string;
  page_id: string;
  at: string;
  text: string;
  created_by_workos_id: string | null;
  created_at: string;
};

// Full-body page saves are last-write-wins on the server, so per-page writes
// must land in order; a per-page promise chain serializes them.
const pageWriteChains = new Map<string, Promise<unknown>>();

function chainPageWrite<T>(pageId: string, write: () => Promise<T>): Promise<T> {
  const chained = (pageWriteChains.get(pageId) ?? Promise.resolve()).then(write, write);
  pageWriteChains.set(
    pageId,
    chained.catch(() => undefined),
  );
  return chained;
}

export type WikiPageWriteMutation = {
  original: GoatWikiPageRow;
  modified: GoatWikiPageRow;
};

/** Update mutations always carry the full pre-image; only inserts have `{}`. */
export function asWikiPageWriteMutations(
  mutations: ReadonlyArray<{ original: unknown; modified: unknown }>,
): WikiPageWriteMutation[] {
  return mutations.map((mutation) => ({
    original: mutation.original as GoatWikiPageRow,
    modified: mutation.modified as GoatWikiPageRow,
  }));
}

/**
 * Persists page-row update mutations (title/body/kind — path never changes
 * here; moves are an agent-tool capability). Shared by the collection's
 * onUpdate handler and the debounced typing pipeline. Returns the txids of
 * every wiki_pages statement.
 */
export async function persistWikiPageWrites(
  mutations: ReadonlyArray<WikiPageWriteMutation>,
): Promise<number[]> {
  const txids: number[] = [];
  for (const mutation of mutations) {
    const result = await chainPageWrite(mutation.original.id, () =>
      saveWikiPageAction({
        path: mutation.original.path,
        body: mutation.modified.content,
        kind: mutation.modified.kind,
        title: mutation.modified.title,
      }),
    );
    if (!result.ok) throw new Error(result.error);
    txids.push(...result.txids);
  }
  return txids;
}

// Subtree deletes arrive as one transaction holding the root and all its
// descendants; the server action deletes recursively from each root.
function deleteRoots(mutations: Array<{ original: GoatWikiPageRow }>): GoatWikiPageRow[] {
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

function createWikiCollections(workspaceId: string) {
  const pages = createGoatElectricCollection<GoatWikiPageRow>({
    id: `goat:wiki_pages:${workspaceId}`,
    table: "goat.wiki_pages",
    getKey: (row) => row.id,
    onInsert: async ({ transaction }) => {
      const txids: number[] = [];
      for (const mutation of transaction.mutations) {
        const row = mutation.modified;
        const result = await createWikiPageAction({
          id: row.id,
          slug: row.slug,
          parentPath: parentWikiPath(row.path),
          title: row.title,
        });
        if (!result.ok) throw new Error(result.error);
        txids.push(...result.txids);
      }
      return { txid: txids };
    },
    onUpdate: async ({ transaction }) => ({
      txid: await persistWikiPageWrites(asWikiPageWriteMutations(transaction.mutations)),
    }),
    onDelete: async ({ transaction }) => {
      const txids: number[] = [];
      for (const root of deleteRoots(transaction.mutations)) {
        const result = await deleteWikiPageAction({ slug: root.slug, recursive: true });
        if (!result.ok) throw new Error(result.error);
        txids.push(...result.txids);
      }
      return { txid: txids };
    },
  });

  const timelineEntries = createGoatElectricCollection<GoatWikiTimelineEntryRow>({
    id: `goat:wiki_timeline_entries:${workspaceId}`,
    table: "goat.wiki_timeline_entries",
    getKey: (row) => row.id,
    onInsert: async ({ transaction }) => {
      const txids: number[] = [];
      for (const mutation of transaction.mutations) {
        const row = mutation.modified;
        const slug = pages.get(row.page_id)?.slug;
        if (!slug) throw new Error("Cannot add a timeline entry to an unknown page.");
        const result = await addWikiTimelineEntryAction({
          id: row.id,
          slug,
          text: row.text,
          at: row.at,
        });
        if (!result.ok) throw new Error(result.error);
        txids.push(result.txid);
      }
      return { txid: txids };
    },
  });

  return { pages, timelineEntries };
}

export type GoatWikiCollections = ReturnType<typeof createWikiCollections>;

const wikiCollectionsByWorkspaceId = new Map<string, GoatWikiCollections>();

// The Electric shape proxy scopes wiki shapes to the session's active
// workspace server-side; the workspace id here only namespaces the client
// cache so switching workspaces never shows stale trees.
export function getGoatWikiCollections(workspaceId: string): GoatWikiCollections {
  const cached = wikiCollectionsByWorkspaceId.get(workspaceId);
  if (cached) return cached;
  const collections = createWikiCollections(workspaceId);
  wikiCollectionsByWorkspaceId.set(workspaceId, collections);
  return collections;
}
