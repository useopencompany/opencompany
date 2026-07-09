import { and, desc, eq, gte, inArray, isNull, like, ne, or, type SQL, sql } from "drizzle-orm";
import {
  createGateway,
  GOAT_BRAIN_WEIGHT_FRESHNESS,
  GOAT_BRAIN_WEIGHT_RELEVANCE,
  type GoatBrainEntityType,
  type GoatBrainGraphHop,
  type GoatBrainKind,
  type GoatBrainSource,
  type GoatBrainUsageEntry,
  goatBrainFreshness,
  parseGoatBrainDocument,
  reciprocalRankFusion,
  titleTagMatch,
} from "../../goat-brain/src/index";
import { getDb } from "./client";
import {
  goatBrainDocumentEmbeddings,
  goatBrainDocuments,
  goatBrainEdges,
  goatBrainTimelineEntries,
} from "./goat-schema";

// Goat Brain read plane. Every DB-backed consumer (chat tool, MCP connector, HTTP surfaces)
// reads the brain through this module: indexed SQL over the projections that the write path
// already maintains (search_tsv, name_text, brain_edges, brain_timeline_entries,
// brain_document_embeddings) — no brain materialization, no CLI spawn, no LLM calls in the
// ranking loop. The one model dependency is embeddings (query text + write-through backfill of
// changed documents), and any gateway failure degrades silently to lexical ranking, matching the
// CLI's behavior. The filesystem path in @opencompany/goat-brain remains for local roots and the
// ingestion agent's per-job sandbox (which needs read-your-writes against uncommitted files).

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const FTS_CANDIDATE_LIMIT = 50;
const NAME_CANDIDATE_LIMIT = 20;
const VECTOR_CANDIDATE_LIMIT = 50;
// Per-query cap on write-through embedding backfill. After a large ingest the first semantic
// query warms up to this many documents; anything beyond stays lexical-only until later queries.
const EMBED_BACKFILL_LIMIT = 64;
const EMBED_TEXT_MAX_CHARS = 8000;
const SNIPPET_MAX_CHARS = 1200;
const ASSET_TEXT_MAX_CHARS = 20_000;
const NEIGHBOR_LIMIT = 5;
const LINKS_LIMIT = 50;
const TIMELINE_RECENT_LIMIT = 20;
const MAX_GET_IDS = 20;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_TIMELINE_LIMIT = 200;
const HOP_DECAY = 0.5;
const GRAPH_SEED_LIMIT = 20;

const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

// Matches goat-brain-files.ts DbClient: neon-http (web) and pooled node-postgres (runner) differ
// in type identity, so the module accepts either.
type DbClient = any;

export type GoatBrainReadContext = {
  brainRef: string; // already access-checked by the caller's authz layer
  gatewayApiKey?: string; // absent → lexical-only ranking
  db?: DbClient;
  onUsage?: (entry: GoatBrainUsageEntry) => void;
};

export type GoatBrainSearchOptions = {
  text: string;
  folder?: string;
  type?: string;
  kind?: GoatBrainKind;
  since?: string;
  limit?: number;
  hops?: number;
  includeMerged?: boolean;
  includeArchived?: boolean;
  lexicalOnly?: boolean;
};

export type GoatBrainSearchSignal = "lexical" | "name" | "vector" | "graph";

export type GoatBrainSearchHit = {
  id: string;
  title: string;
  type: string;
  kind: string;
  folder: string;
  status: string;
  updatedAt: string;
  score: number;
  signals: GoatBrainSearchSignal[];
  snippet: string;
  neighbors: GoatBrainDocumentLink[];
  via?: GoatBrainGraphHop[];
};

export type GoatBrainDocumentLink = {
  id: string;
  title: string;
  relationType: string;
  direction: "out" | "in";
};

export type GoatBrainDocumentRead = {
  requestedId: string;
  id: string;
  resolvedVia: "id" | "alias" | "merged";
  title: string;
  folder: string;
  kind: string;
  type: string;
  format: string;
  status: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  compiledTruth: string;
  // Machine-extracted text for binary-backed documents (pdf/docx), capped for tool output.
  assetText?: string;
  // Chronological tail of the timeline; fetch the full history via getGoatBrainTimeline.
  timeline: Array<{ at: string; evidenceId: string; body: string }>;
  timelineTotal: number;
  sources: GoatBrainSource[];
  links: GoatBrainDocumentLink[];
};

export type GoatBrainTimelineRead = {
  at: string;
  evidenceId: string;
  summary: string;
  detail: string;
  sourceRef: string;
  sourceTitle: string | null;
};

export type GoatBrainDocumentSummary = {
  id: string;
  title: string;
  type: string;
  kind: string;
  folder: string;
  status: string;
  updatedAt: string;
};

export async function searchGoatBrain(
  ctx: GoatBrainReadContext,
  options: GoatBrainSearchOptions,
  now: number = Date.now(),
): Promise<GoatBrainSearchHit[]> {
  const db = ctx.db ?? getDb();
  const text = options.text?.trim() ?? "";
  const limit = clamp(options.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const hops = Math.max(0, options.hops ?? 0);
  const conditions = documentFilters(ctx.brainRef, options, hops);

  // No query text → freshness-ordered browse over the filtered set (CLI parity: every candidate
  // gets relevance 1 and the recency blend decides).
  if (!text) {
    const rows = await fetchDocumentMetaWhere(db, and(...conditions), limit);
    return rows.map((row) => hitFromMeta(row, blendScore(1, 1, row.updatedAt, now)));
  }

  const [ftsIds, nameIds, vectorIds] = await Promise.all([
    ftsCandidates(db, conditions, text),
    nameCandidates(db, conditions, text),
    options.lexicalOnly || !ctx.gatewayApiKey
      ? Promise.resolve([] as string[])
      : vectorCandidates(db, ctx, conditions, text),
  ]);

  const lists = [ftsIds, nameIds, vectorIds].filter((list) => list.length > 0);
  const relevance = reciprocalRankFusion(lists);
  const signalsById = new Map<string, Set<GoatBrainSearchSignal>>();
  addSignal(signalsById, ftsIds, "lexical");
  addSignal(signalsById, nameIds, "name");
  addSignal(signalsById, vectorIds, "vector");

  const graphPaths = new Map<string, GoatBrainGraphHop[]>();
  let adjacency: Map<string, GoatBrainGraphHop[]> | null = null;
  if (hops > 0 && relevance.size > 0) {
    adjacency = await loadAdjacency(db, ctx.brainRef);
    const allowed = await filteredIdSet(db, conditions);
    expandAlongGraph(relevance, graphPaths, adjacency, allowed, hops);
    for (const id of graphPaths.keys()) addSignal(signalsById, [id], "graph");
  }
  if (relevance.size === 0) return [];

  const meta = await fetchDocumentMetaByIds(db, ctx.brainRef, [...relevance.keys()]);
  applyNameBoost(relevance, meta, text);

  const maxRelevance = Math.max(...relevance.values(), 0) || 1;
  const ranked = [...relevance.entries()]
    .flatMap(([id, rel]) => {
      const record = meta.get(id);
      // Graph hops can reach ids whose documents were deleted or filtered; drop them.
      if (!record) return [];
      return [{ record, score: blendScore(rel, maxRelevance, record.updatedAt, now) }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const neighborsById = await fetchNeighbors(
    db,
    ctx.brainRef,
    ranked.map(({ record }) => record.brainId),
    adjacency,
  );

  return ranked.map(({ record, score }) => {
    const via = graphPaths.get(record.brainId);
    return {
      ...hitFromMeta(record, score),
      signals: [...(signalsById.get(record.brainId) ?? [])],
      neighbors: neighborsById.get(record.brainId) ?? [],
      ...(via ? { via } : {}),
    };
  });
}

export async function getGoatBrainDocuments(
  ctx: GoatBrainReadContext,
  ids: string[],
): Promise<{ documents: GoatBrainDocumentRead[]; missing: string[] }> {
  const db = ctx.db ?? getDb();
  const requested = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, MAX_GET_IDS);
  if (requested.length === 0) return { documents: [], missing: [] };

  const resolved = new Map<string, { row: DocumentRow; resolvedVia: "id" | "alias" | "merged" }>();
  const exact: DocumentRow[] = await db
    .select()
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.brainRef, ctx.brainRef),
        inArray(goatBrainDocuments.brainId, requested),
      ),
    );
  for (const row of exact) resolved.set(row.brainId, { row, resolvedVia: "id" });

  const unresolved = requested.filter((id) => !resolved.has(id));
  if (unresolved.length > 0) {
    const lowered = unresolved.map((id) => id.toLowerCase());
    const aliasRows: DocumentRow[] = await db
      .select()
      .from(goatBrainDocuments)
      .where(
        and(
          eq(goatBrainDocuments.brainRef, ctx.brainRef),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${goatBrainDocuments.aliases}) AS alias(value)
            WHERE lower(alias.value) IN (${sql.join(
              lowered.map((value) => sql`${value}`),
              sql`, `,
            )})
          )`,
        ),
      );
    for (const id of unresolved) {
      const match = aliasRows.find((row) =>
        (row.aliases ?? []).some((alias) => alias.toLowerCase() === id.toLowerCase()),
      );
      if (match) resolved.set(id, { row: match, resolvedVia: "alias" });
    }
  }

  // Merged documents redirect to their merge target (one level; a merged target is returned
  // as-is rather than chased through chains).
  const mergeTargets = new Map<string, string>();
  for (const [requestedId, entry] of resolved) {
    if (entry.row.status !== "merged") continue;
    const target = mergedInto(entry.row);
    if (target && target !== entry.row.brainId) mergeTargets.set(requestedId, target);
  }
  if (mergeTargets.size > 0) {
    const targetRows: DocumentRow[] = await db
      .select()
      .from(goatBrainDocuments)
      .where(
        and(
          eq(goatBrainDocuments.brainRef, ctx.brainRef),
          inArray(goatBrainDocuments.brainId, [...new Set(mergeTargets.values())]),
        ),
      );
    const targetsById = new Map(targetRows.map((row) => [row.brainId, row]));
    for (const [requestedId, targetId] of mergeTargets) {
      const target = targetsById.get(targetId);
      if (target) resolved.set(requestedId, { row: target, resolvedVia: "merged" });
    }
  }

  const canonicalIds = [...new Set([...resolved.values()].map(({ row }) => row.brainId))];
  const linksById = await fetchLinks(db, ctx.brainRef, canonicalIds, LINKS_LIMIT);

  const documents = requested.flatMap((requestedId) => {
    const entry = resolved.get(requestedId);
    if (!entry) return [];
    const { row, resolvedVia } = entry;
    const timeline = [...(row.timeline ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const assetText = (row.assetExtractedText ?? "").trim();
    return [
      {
        requestedId,
        id: row.brainId,
        resolvedVia,
        title: row.title ?? row.brainId,
        folder: row.folderPath,
        kind: row.kind,
        type: row.entityType,
        format: row.format,
        status: row.status,
        aliases: row.aliases ?? [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        compiledTruth: row.body,
        ...(assetText
          ? {
              assetText:
                assetText.length <= ASSET_TEXT_MAX_CHARS
                  ? assetText
                  : `${assetText.slice(0, ASSET_TEXT_MAX_CHARS).trimEnd()}... [truncated extracted text]`,
            }
          : {}),
        timeline: timeline.slice(-TIMELINE_RECENT_LIMIT).map((item) => ({
          at: item.at,
          evidenceId: item.evidenceId,
          body: item.body,
        })),
        timelineTotal: timeline.length,
        sources: row.sources ?? [],
        links: linksById.get(row.brainId) ?? [],
      } satisfies GoatBrainDocumentRead,
    ];
  });

  return {
    documents,
    missing: requested.filter((id) => !resolved.has(id)),
  };
}

export async function getGoatBrainTimeline(
  ctx: GoatBrainReadContext,
  id: string,
  options: { since?: string; limit?: number } = {},
): Promise<{ id: string; entries: GoatBrainTimelineRead[] } | null> {
  const db = ctx.db ?? getDb();
  const { documents } = await getGoatBrainDocuments(ctx, [id]);
  const doc = documents[0];
  if (!doc) return null;
  const limit = clamp(options.limit ?? DEFAULT_TIMELINE_LIMIT, 1, MAX_TIMELINE_LIMIT);
  const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
  if (options.since && Number.isNaN(sinceMs)) {
    throw new Error(`Invalid "since" value: ${options.since}`);
  }

  const rows = await db
    .select({
      at: goatBrainTimelineEntries.at,
      evidenceId: goatBrainTimelineEntries.evidenceId,
      summary: goatBrainTimelineEntries.summary,
      detail: goatBrainTimelineEntries.detail,
      sourceRef: goatBrainTimelineEntries.sourceRef,
      sourceTitle: goatBrainTimelineEntries.sourceTitle,
    })
    .from(goatBrainTimelineEntries)
    .where(
      and(
        eq(goatBrainTimelineEntries.brainRef, ctx.brainRef),
        eq(goatBrainTimelineEntries.brainId, doc.id),
        ...(Number.isNaN(sinceMs) ? [] : [gte(goatBrainTimelineEntries.at, new Date(sinceMs))]),
      ),
    )
    .orderBy(desc(goatBrainTimelineEntries.at))
    .limit(limit);

  return {
    id: doc.id,
    entries: rows.map(
      (row: {
        at: Date;
        evidenceId: string;
        summary: string;
        detail: string;
        sourceRef: string;
        sourceTitle: string | null;
      }) => ({
        at: row.at.toISOString(),
        evidenceId: row.evidenceId,
        summary: row.summary,
        detail: row.detail,
        sourceRef: row.sourceRef,
        sourceTitle: row.sourceTitle,
      }),
    ),
  };
}

export async function listGoatBrainDocuments(
  ctx: GoatBrainReadContext,
  options: {
    folder?: string;
    type?: string;
    kind?: GoatBrainKind;
    limit?: number;
    includeMerged?: boolean;
    includeArchived?: boolean;
  } = {},
): Promise<GoatBrainDocumentSummary[]> {
  const db = ctx.db ?? getDb();
  const limit = clamp(options.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const conditions = documentFilters(ctx.brainRef, options, 0);
  const rows = await fetchDocumentMetaWhere(db, and(...conditions), limit);
  return rows.map((row) => ({
    id: row.brainId,
    title: row.title ?? row.brainId,
    type: row.entityType,
    kind: row.kind,
    folder: row.folderPath,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

// --- filters & candidates -------------------------------------------------------------------

function documentFilters(
  brainRef: string,
  options: Pick<
    GoatBrainSearchOptions,
    "folder" | "type" | "kind" | "since" | "includeMerged" | "includeArchived"
  >,
  hops: number,
): SQL[] {
  const conditions: (SQL | undefined)[] = [eq(goatBrainDocuments.brainRef, brainRef)];
  if (options.folder) {
    conditions.push(
      or(
        eq(goatBrainDocuments.folderPath, options.folder),
        like(goatBrainDocuments.folderPath, `${options.folder}/%`),
      ),
    );
  }
  if (options.type) {
    conditions.push(eq(goatBrainDocuments.entityType, options.type as GoatBrainEntityType));
  }
  // CLI parity: graph expansion works over pages; evidence stays reachable via links and the
  // explicit kind filter.
  const kind = options.kind ?? (hops > 0 ? "page" : undefined);
  if (kind) conditions.push(eq(goatBrainDocuments.kind, kind));
  if (options.since) {
    const sinceMs = Date.parse(options.since);
    if (Number.isNaN(sinceMs)) throw new Error(`Invalid "since" value: ${options.since}`);
    conditions.push(gte(goatBrainDocuments.updatedAt, new Date(sinceMs)));
  }
  if (!options.includeMerged) conditions.push(ne(goatBrainDocuments.status, "merged"));
  if (!options.includeArchived) conditions.push(ne(goatBrainDocuments.status, "archived"));
  return conditions.filter((condition): condition is SQL => condition !== undefined);
}

async function ftsCandidates(db: DbClient, conditions: SQL[], text: string): Promise<string[]> {
  const rank = sql`ts_rank_cd(${goatBrainDocuments.searchTsv}, websearch_to_tsquery('english', ${text}))`;
  const rows: Array<{ id: string }> = await db
    .select({ id: goatBrainDocuments.brainId })
    .from(goatBrainDocuments)
    .where(
      and(
        ...conditions,
        sql`websearch_to_tsquery('english', ${text}) @@ ${goatBrainDocuments.searchTsv}`,
      ),
    )
    .orderBy(desc(rank))
    .limit(FTS_CANDIDATE_LIMIT);
  return rows.map((row) => row.id);
}

async function nameCandidates(db: DbClient, conditions: SQL[], text: string): Promise<string[]> {
  const similarity = sql`word_similarity(${text}, ${goatBrainDocuments.nameText})`;
  const rows: Array<{ id: string }> = await db
    .select({ id: goatBrainDocuments.brainId })
    .from(goatBrainDocuments)
    .where(and(...conditions, sql`${text} <% ${goatBrainDocuments.nameText}`))
    .orderBy(desc(similarity))
    .limit(NAME_CANDIDATE_LIMIT);
  return rows.map((row) => row.id);
}

async function vectorCandidates(
  db: DbClient,
  ctx: GoatBrainReadContext,
  conditions: SQL[],
  text: string,
): Promise<string[]> {
  // Ranking assist only: any gateway or pgvector failure degrades this list to empty and the
  // query stays lexical, mirroring the CLI's silent degrade.
  try {
    const model = process.env.GOAT_BRAIN_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
    const embeddingJoin = and(
      eq(goatBrainDocumentEmbeddings.documentId, goatBrainDocuments.id),
      eq(goatBrainDocumentEmbeddings.contentHash, goatBrainDocuments.contentHash),
      eq(goatBrainDocumentEmbeddings.model, model),
    );

    const missing: Array<{
      documentId: string;
      contentHash: string;
      title: string | null;
      aliases: string[] | null;
      body: string;
    }> = await db
      .select({
        documentId: goatBrainDocuments.id,
        contentHash: goatBrainDocuments.contentHash,
        title: goatBrainDocuments.title,
        aliases: goatBrainDocuments.aliases,
        body: goatBrainDocuments.body,
      })
      .from(goatBrainDocuments)
      .leftJoin(goatBrainDocumentEmbeddings, embeddingJoin)
      .where(and(...conditions, isNull(goatBrainDocumentEmbeddings.documentId)))
      .limit(EMBED_BACKFILL_LIMIT);

    const gateway = createGateway({
      apiKey: ctx.gatewayApiKey ?? "",
      embeddingModel: model,
      ...(process.env.GOAT_BRAIN_GATEWAY_BASE_URL
        ? { baseUrl: process.env.GOAT_BRAIN_GATEWAY_BASE_URL }
        : {}),
      ...(ctx.onUsage ? { onUsage: ctx.onUsage } : {}),
    });

    // One embeddings call covers the query and the backfill batch.
    const vectors = await gateway.embed([
      text,
      ...missing.map((doc) => embeddingTextFor(doc.title ?? "", doc.aliases ?? [], doc.body)),
    ]);
    const queryVector = vectors[0];
    if (!queryVector) return [];

    const upserts = missing.flatMap((doc, index) => {
      const vector = vectors[index + 1];
      if (!vector) return [];
      return [
        {
          documentId: doc.documentId,
          brainRef: ctx.brainRef,
          contentHash: doc.contentHash,
          model,
          embedding: JSON.stringify(vector),
          updatedAt: new Date(),
        },
      ];
    });
    if (upserts.length > 0) {
      await db
        .insert(goatBrainDocumentEmbeddings)
        .values(upserts)
        .onConflictDoUpdate({
          target: goatBrainDocumentEmbeddings.documentId,
          set: {
            contentHash: sql`excluded.content_hash`,
            model: sql`excluded.model`,
            embedding: sql`excluded.embedding`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    const rows: Array<{ id: string }> = await db
      .select({ id: goatBrainDocuments.brainId })
      .from(goatBrainDocumentEmbeddings)
      .innerJoin(
        goatBrainDocuments,
        and(
          eq(goatBrainDocuments.id, goatBrainDocumentEmbeddings.documentId),
          eq(goatBrainDocuments.contentHash, goatBrainDocumentEmbeddings.contentHash),
        ),
      )
      .where(and(...conditions, eq(goatBrainDocumentEmbeddings.model, model)))
      .orderBy(
        sql`${goatBrainDocumentEmbeddings.embedding} <=> ${JSON.stringify(queryVector)}::vector`,
      )
      .limit(VECTOR_CANDIDATE_LIMIT);
    return rows.map((row) => row.id);
  } catch {
    return [];
  }
}

function embeddingTextFor(title: string, aliases: string[], body: string): string {
  const text = [title, aliases.join(" "), body].filter(Boolean).join("\n").trim();
  return (text || "empty").slice(0, EMBED_TEXT_MAX_CHARS);
}

// --- graph ----------------------------------------------------------------------------------

async function loadAdjacency(
  db: DbClient,
  brainRef: string,
): Promise<Map<string, GoatBrainGraphHop[]>> {
  const rows: Array<{ from: string; to: string; type: string }> = await db
    .select({
      from: goatBrainEdges.fromBrainId,
      to: goatBrainEdges.toBrainId,
      type: goatBrainEdges.relationType,
    })
    .from(goatBrainEdges)
    .where(eq(goatBrainEdges.brainRef, brainRef));

  const adjacency = new Map<string, GoatBrainGraphHop[]>();
  const push = (key: string, hop: GoatBrainGraphHop) => {
    const existing = adjacency.get(key);
    if (existing) existing.push(hop);
    else adjacency.set(key, [hop]);
  };
  for (const edge of rows) {
    if (edge.from === edge.to) continue;
    push(edge.from, { from: edge.from, type: edge.type, to: edge.to });
    push(edge.to, { from: edge.to, type: edge.type, to: edge.from });
  }
  return adjacency;
}

function expandAlongGraph(
  relevance: Map<string, number>,
  graphPaths: Map<string, GoatBrainGraphHop[]>,
  adjacency: Map<string, GoatBrainGraphHop[]>,
  allowed: Set<string>,
  hops: number,
): void {
  let frontier = [...relevance.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GRAPH_SEED_LIMIT)
    .map(([id, score]) => ({ id, score, path: [] as GoatBrainGraphHop[] }));

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: Array<{ id: string; score: number; path: GoatBrainGraphHop[] }> = [];
    for (const { id, score, path } of frontier) {
      const boosted = score * HOP_DECAY;
      for (const edge of adjacency.get(id) ?? []) {
        if (!allowed.has(edge.to)) continue;
        if (boosted > (relevance.get(edge.to) ?? 0)) {
          const nextPath = [...path, edge];
          relevance.set(edge.to, boosted);
          graphPaths.set(edge.to, nextPath);
          next.push({ id: edge.to, score: boosted, path: nextPath });
        }
      }
    }
    frontier = next;
  }
}

async function filteredIdSet(db: DbClient, conditions: SQL[]): Promise<Set<string>> {
  const rows: Array<{ id: string }> = await db
    .select({ id: goatBrainDocuments.brainId })
    .from(goatBrainDocuments)
    .where(and(...conditions));
  return new Set(rows.map((row) => row.id));
}

async function fetchNeighbors(
  db: DbClient,
  brainRef: string,
  hitIds: string[],
  preloaded: Map<string, GoatBrainGraphHop[]> | null,
): Promise<Map<string, GoatBrainDocumentLink[]>> {
  if (hitIds.length === 0) return new Map();
  const adjacency =
    preloaded ??
    (await (async () => {
      const rows: Array<{ from: string; to: string; type: string }> = await db
        .select({
          from: goatBrainEdges.fromBrainId,
          to: goatBrainEdges.toBrainId,
          type: goatBrainEdges.relationType,
        })
        .from(goatBrainEdges)
        .where(
          and(
            eq(goatBrainEdges.brainRef, brainRef),
            or(
              inArray(goatBrainEdges.fromBrainId, hitIds),
              inArray(goatBrainEdges.toBrainId, hitIds),
            ),
          ),
        );
      const map = new Map<string, GoatBrainGraphHop[]>();
      for (const edge of rows) {
        if (edge.from === edge.to) continue;
        const forward = { from: edge.from, type: edge.type, to: edge.to };
        const reverse = { from: edge.to, type: edge.type, to: edge.from };
        (map.get(edge.from) ?? map.set(edge.from, []).get(edge.from))?.push(forward);
        (map.get(edge.to) ?? map.set(edge.to, []).get(edge.to))?.push(reverse);
      }
      return map;
    })());

  return linksFromAdjacency(db, brainRef, hitIds, adjacency, NEIGHBOR_LIMIT);
}

async function fetchLinks(
  db: DbClient,
  brainRef: string,
  ids: string[],
  limitPerDoc: number,
): Promise<Map<string, GoatBrainDocumentLink[]>> {
  if (ids.length === 0) return new Map();
  const rows: Array<{ from: string; to: string; type: string }> = await db
    .select({
      from: goatBrainEdges.fromBrainId,
      to: goatBrainEdges.toBrainId,
      type: goatBrainEdges.relationType,
    })
    .from(goatBrainEdges)
    .where(
      and(
        eq(goatBrainEdges.brainRef, brainRef),
        or(inArray(goatBrainEdges.fromBrainId, ids), inArray(goatBrainEdges.toBrainId, ids)),
      ),
    );
  const adjacency = new Map<string, GoatBrainGraphHop[]>();
  for (const edge of rows) {
    if (edge.from === edge.to) continue;
    const forward = { from: edge.from, type: edge.type, to: edge.to };
    const reverse = { from: edge.to, type: edge.type, to: edge.from };
    (adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from))?.push(forward);
    (adjacency.get(edge.to) ?? adjacency.set(edge.to, []).get(edge.to))?.push(reverse);
  }
  return linksFromAdjacency(db, brainRef, ids, adjacency, limitPerDoc);
}

// Resolve adjacency rows into links: direction from the hit's perspective, titles joined in, and
// targets that do not exist as documents (e.g. dangling wiki links) dropped.
async function linksFromAdjacency(
  db: DbClient,
  brainRef: string,
  ids: string[],
  adjacency: Map<string, GoatBrainGraphHop[]>,
  limitPerDoc: number,
): Promise<Map<string, GoatBrainDocumentLink[]>> {
  const targetIds = new Set<string>();
  for (const id of ids) for (const hop of adjacency.get(id) ?? []) targetIds.add(hop.to);
  if (targetIds.size === 0) return new Map();

  const titleRows: Array<{ id: string; title: string | null }> = await db
    .select({ id: goatBrainDocuments.brainId, title: goatBrainDocuments.title })
    .from(goatBrainDocuments)
    .where(
      and(
        eq(goatBrainDocuments.brainRef, brainRef),
        inArray(goatBrainDocuments.brainId, [...targetIds]),
      ),
    );
  const titles = new Map(titleRows.map((row) => [row.id, row.title ?? row.id]));

  const links = new Map<string, GoatBrainDocumentLink[]>();
  for (const id of ids) {
    const seen = new Set<string>();
    const entries: GoatBrainDocumentLink[] = [];
    for (const hop of adjacency.get(id) ?? []) {
      const title = titles.get(hop.to);
      if (title === undefined) continue;
      const key = `${hop.type}:${hop.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: hop.to,
        title,
        relationType: hop.type,
        direction: hop.from === id ? "out" : "in",
      });
      if (entries.length >= limitPerDoc) break;
    }
    if (entries.length > 0) links.set(id, entries);
  }
  return links;
}

// --- scoring & metadata ---------------------------------------------------------------------

type DocumentMetaRow = {
  brainId: string;
  folderPath: string;
  title: string | null;
  entityType: string;
  kind: string;
  status: string;
  aliases: string[] | null;
  updatedAt: Date;
  snippetSource: string;
  bodyLength: number;
};

type DocumentRow = typeof goatBrainDocuments.$inferSelect;

const documentMetaSelection = {
  brainId: goatBrainDocuments.brainId,
  folderPath: goatBrainDocuments.folderPath,
  title: goatBrainDocuments.title,
  entityType: goatBrainDocuments.entityType,
  kind: goatBrainDocuments.kind,
  status: goatBrainDocuments.status,
  aliases: goatBrainDocuments.aliases,
  updatedAt: goatBrainDocuments.updatedAt,
  snippetSource: sql<string>`left(${goatBrainDocuments.body}, ${SNIPPET_MAX_CHARS + 100})`,
  bodyLength: sql<number>`length(${goatBrainDocuments.body})`,
};

async function fetchDocumentMetaByIds(
  db: DbClient,
  brainRef: string,
  ids: string[],
): Promise<Map<string, DocumentMetaRow>> {
  if (ids.length === 0) return new Map();
  const rows: DocumentMetaRow[] = await db
    .select(documentMetaSelection)
    .from(goatBrainDocuments)
    .where(
      and(eq(goatBrainDocuments.brainRef, brainRef), inArray(goatBrainDocuments.brainId, ids)),
    );
  return new Map(rows.map((row) => [row.brainId, row]));
}

async function fetchDocumentMetaWhere(
  db: DbClient,
  where: SQL | undefined,
  limit: number,
): Promise<DocumentMetaRow[]> {
  return db
    .select(documentMetaSelection)
    .from(goatBrainDocuments)
    .where(where)
    .orderBy(desc(goatBrainDocuments.updatedAt))
    .limit(limit);
}

function applyNameBoost(
  relevance: Map<string, number>,
  meta: Map<string, DocumentMetaRow>,
  text: string,
): void {
  let maxRelevance = 0;
  for (const value of relevance.values()) maxRelevance = Math.max(maxRelevance, value);
  maxRelevance = maxRelevance || 1;
  for (const [id, record] of meta) {
    const match = titleTagMatch(
      { title: record.title ?? record.brainId, aliases: record.aliases ?? [] },
      text,
    );
    if (match > 0) relevance.set(id, (relevance.get(id) ?? 0) + match * maxRelevance);
  }
}

function blendScore(relevance: number, maxRelevance: number, updatedAt: Date, now: number): number {
  return (
    GOAT_BRAIN_WEIGHT_RELEVANCE * (relevance / maxRelevance) +
    GOAT_BRAIN_WEIGHT_FRESHNESS * goatBrainFreshness(updatedAt, now)
  );
}

function hitFromMeta(record: DocumentMetaRow, score: number): GoatBrainSearchHit {
  return {
    id: record.brainId,
    title: record.title ?? record.brainId,
    type: record.entityType,
    kind: record.kind,
    folder: record.folderPath,
    status: record.status,
    updatedAt: record.updatedAt.toISOString(),
    score: Number(score.toFixed(4)),
    signals: [],
    snippet: snippetFor(record),
    neighbors: [],
  };
}

function snippetFor(record: DocumentMetaRow): string {
  const truth = record.snippetSource.trim();
  if (!truth) return "_No compiled truth yet._";
  if (record.bodyLength <= SNIPPET_MAX_CHARS) return truth;
  return `${truth.slice(0, SNIPPET_MAX_CHARS).trimEnd()}... [truncated; fetch the full document with get ${record.brainId}]`;
}

function mergedInto(row: DocumentRow): string | null {
  try {
    return parseGoatBrainDocument(row.content).frontmatter.mergedInto ?? null;
  } catch {
    return null;
  }
}

function addSignal(
  signals: Map<string, Set<GoatBrainSearchSignal>>,
  ids: string[],
  signal: GoatBrainSearchSignal,
): void {
  for (const id of ids) {
    const existing = signals.get(id);
    if (existing) existing.add(signal);
    else signals.set(id, new Set([signal]));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}
