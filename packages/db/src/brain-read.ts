import { and, asc, desc, eq, gte, inArray, isNull, like, ne, or, type SQL, sql } from "drizzle-orm";
import {
  BRAIN_WEIGHT_FRESHNESS,
  BRAIN_WEIGHT_RELEVANCE,
  type BrainEntityType,
  type BrainGraphHop,
  type BrainKind,
  type BrainSource,
  type BrainUsageEntry,
  brainFreshness,
  createGateway,
  parseBrainDocument,
  reciprocalRankFusion,
  titleTagMatch,
} from "../../brain/src/index";
import { getDb } from "./client";
import {
  brainDocumentEmbeddings,
  brainDocuments,
  brainEdges,
  brainTimelineEntries,
} from "./product-schema";

// opencompany Brain read plane. Every DB-backed consumer (chat tool, MCP connector, HTTP surfaces)
// reads the brain through this module: indexed SQL over the projections that the write path
// already maintains (search_tsv, name_text, brain_edges, brain_timeline_entries,
// brain_document_embeddings) — no brain materialization, no CLI spawn, no LLM calls in the
// ranking loop. The one model dependency is embeddings (query text + write-through backfill of
// changed documents), and any gateway failure degrades silently to lexical ranking, matching the
// CLI's behavior. The filesystem path in @opencompany/brain remains for local roots and the
// ingestion agent's per-job sandbox (which needs read-your-writes against uncommitted files).

const DEFAULT_SEARCH_LIMIT = 10;
// The public tool caps pages at 50 and requests one extra hit to determine whether a continuation
// exists, so the read plane deliberately permits a 51-row internal window.
const MAX_SEARCH_LIMIT = 51;
const FTS_CANDIDATE_LIMIT = 50;
const NAME_CANDIDATE_LIMIT = 20;
const VECTOR_CANDIDATE_LIMIT = 50;
// Cosine-distance cutoff for vector candidates. Beyond this an embedding neighbor is treated as
// semantic noise and dropped before RRF, so a gibberish query returns nothing rather than the
// nearest-but-irrelevant page. Conservative default for text-embedding-3-small, tunable per deploy.
const VECTOR_MAX_DISTANCE_DEFAULT = 0.8;
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
const RELATIVE_SINCE = /^(\d+)\s*([mhdw])$/i;
const NATURAL_RELATIVE_SINCE =
  /^(?:last\s+)?(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)$/i;
const SINCE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

// Matches brain-files.ts DbClient: neon-http (web) and pooled node-postgres (runner) differ
// in type identity, so the module accepts either.
type DbClient = any;

type ReadPlaneGraphEdge = {
  from: string;
  to: string;
  type: string;
  sourceKind: string;
  neighborId: string;
  direction: "out" | "in";
};

export type BrainReadContext = {
  brainRef: string; // already access-checked by the caller's authz layer
  gatewayApiKey?: string; // absent → lexical-only ranking
  db?: DbClient;
  onUsage?: (entry: BrainUsageEntry) => void;
  reporting?: {
    user?: string;
    tags?: readonly string[];
  };
};

export type BrainSearchOptions = {
  text: string;
  folder?: string;
  type?: string;
  kind?: BrainKind;
  since?: string;
  limit?: number;
  offset?: number;
  hops?: number;
  includeMerged?: boolean;
  includeArchived?: boolean;
  // Conflict copies (pages carrying a conflicts_with relation, written when a
  // sync loses a same-page race) are pending curation, not knowledge; they are
  // hidden from search/list by default so they cannot outrank the canonical page.
  includeConflicts?: boolean;
  lexicalOnly?: boolean;
  // Linked-page neighbors are the biggest per-hit payload; callers that only need ids
  // (e.g. the MCP surface) can opt out. Defaults to true for CLI/chat parity.
  includeNeighbors?: boolean;
  // Truncation length for each hit's snippet, clamped to 0..SNIPPET_MAX_CHARS. 0 → no snippet.
  snippetChars?: number;
};

export type BrainSearchSignal = "lexical" | "name" | "vector" | "graph";

export type BrainSearchHit = {
  id: string;
  title: string;
  type: string;
  kind: string;
  folder: string;
  status: string;
  updatedAt: string;
  score: number;
  signals: BrainSearchSignal[];
  // Absolute cosine similarity (1 - distance) for hits that surfaced via the vector index. The
  // relative `score` is a within-response rank; this is the trustworthy confidence number.
  vectorSimilarity?: number;
  snippet: string;
  neighbors: BrainDocumentLink[];
  via?: BrainGraphHop[];
};

type VectorCandidate = { id: string; distance: number };

export type BrainDocumentLink = {
  id: string;
  title: string;
  kind: string;
  type: string;
  folder: string;
  status: string;
  relationType: string;
  sourceKind: string;
  direction: "out" | "in";
};

export type BrainDocumentRead = {
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
  // Machine-extracted text for file-backed documents, capped for tool output.
  assetText?: string;
  // Chronological tail of the timeline; fetch the full history via getBrainTimeline.
  timeline: Array<{ at: string; evidenceId: string; body: string }>;
  timelineTotal: number;
  sources: BrainSource[];
  links: BrainDocumentLink[];
};

export type BrainTimelineRead = {
  at: string;
  evidenceId: string;
  summary: string;
  detail: string;
  sourceRef: string;
  sourceTitle: string | null;
};

export type BrainDocumentSummary = {
  id: string;
  title: string;
  type: string;
  kind: string;
  folder: string;
  status: string;
  updatedAt: string;
};

export async function searchBrain(
  ctx: BrainReadContext,
  options: BrainSearchOptions,
  now: number = Date.now(),
): Promise<BrainSearchHit[]> {
  const db = ctx.db ?? getDb();
  const text = options.text?.trim() ?? "";
  const limit = clamp(options.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const snippetChars = clamp(options.snippetChars ?? SNIPPET_MAX_CHARS, 0, SNIPPET_MAX_CHARS);
  const includeNeighbors = options.includeNeighbors ?? true;
  const hops = Math.max(0, options.hops ?? 0);
  // Curated pages are the default retrieval surface. Evidence remains available through an
  // explicit kind=evidence search or from a page's links/timeline via get/timeline.
  const conditions = documentFilters(
    ctx.brainRef,
    { ...options, kind: options.kind ?? "page" },
    hops,
    now,
  );

  // No query text → freshness-ordered browse over the filtered set (CLI parity: every candidate
  // gets relevance 1 and the recency blend decides).
  if (!text) {
    const rows = await fetchDocumentMetaWhere(db, and(...conditions), limit, offset);
    const neighborsById = includeNeighbors
      ? await fetchNeighbors(
          db,
          ctx.brainRef,
          rows.map((row) => row.brainId),
          null,
        )
      : new Map<string, BrainDocumentLink[]>();
    return rows.map((row) => ({
      ...hitFromMeta(row, blendScore(1, 1, row.updatedAt, now), snippetChars),
      neighbors: neighborsById.get(row.brainId) ?? [],
    }));
  }

  const [ftsIds, nameIds, vectorHits] = await Promise.all([
    ftsCandidates(db, conditions, text),
    nameCandidates(db, conditions, text),
    options.lexicalOnly || !ctx.gatewayApiKey
      ? Promise.resolve([] as VectorCandidate[])
      : vectorCandidates(db, ctx, conditions, text),
  ]);
  const vectorIds = vectorHits.map((hit) => hit.id);
  const vectorSimilarityById = new Map(
    vectorHits.map((hit) => [hit.id, Number((1 - hit.distance).toFixed(4))]),
  );

  const lists = [ftsIds, nameIds, vectorIds].filter((list) => list.length > 0);
  const relevance = reciprocalRankFusion(lists);
  const signalsById = new Map<string, Set<BrainSearchSignal>>();
  addSignal(signalsById, ftsIds, "lexical");
  addSignal(signalsById, nameIds, "name");
  addSignal(signalsById, vectorIds, "vector");

  const graphPaths = new Map<string, BrainGraphHop[]>();
  let adjacency: Map<string, ReadPlaneGraphEdge[]> | null = null;
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
    .sort((a, b) => b.score - a.score || a.record.brainId.localeCompare(b.record.brainId))
    .slice(offset, offset + limit);

  const neighborsById = includeNeighbors
    ? await fetchNeighbors(
        db,
        ctx.brainRef,
        ranked.map(({ record }) => record.brainId),
        adjacency,
      )
    : new Map<string, BrainDocumentLink[]>();

  return ranked.map(({ record, score }) => {
    const via = graphPaths.get(record.brainId);
    const vectorSimilarity = vectorSimilarityById.get(record.brainId);
    return {
      ...hitFromMeta(record, score, snippetChars),
      signals: [...(signalsById.get(record.brainId) ?? [])],
      neighbors: neighborsById.get(record.brainId) ?? [],
      ...(vectorSimilarity !== undefined ? { vectorSimilarity } : {}),
      ...(via ? { via } : {}),
    };
  });
}

export async function getBrainDocuments(
  ctx: BrainReadContext,
  ids: string[],
): Promise<{ documents: BrainDocumentRead[]; missing: string[] }> {
  const db = ctx.db ?? getDb();
  const requested = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, MAX_GET_IDS);
  if (requested.length === 0) return { documents: [], missing: [] };

  const resolved = new Map<string, { row: DocumentRow; resolvedVia: "id" | "alias" | "merged" }>();
  const exact: DocumentRow[] = await db
    .select()
    .from(brainDocuments)
    .where(
      and(eq(brainDocuments.brainRef, ctx.brainRef), inArray(brainDocuments.brainId, requested)),
    );
  for (const row of exact) resolved.set(row.brainId, { row, resolvedVia: "id" });

  const unresolved = requested.filter((id) => !resolved.has(id));
  if (unresolved.length > 0) {
    const lowered = unresolved.map((id) => id.toLowerCase());
    const aliasRows: DocumentRow[] = await db
      .select()
      .from(brainDocuments)
      .where(
        and(
          eq(brainDocuments.brainRef, ctx.brainRef),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${brainDocuments.aliases}) AS alias(value)
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
      .from(brainDocuments)
      .where(
        and(
          eq(brainDocuments.brainRef, ctx.brainRef),
          inArray(brainDocuments.brainId, [...new Set(mergeTargets.values())]),
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
      } satisfies BrainDocumentRead,
    ];
  });

  return {
    documents,
    missing: requested.filter((id) => !resolved.has(id)),
  };
}

export async function getBrainTimeline(
  ctx: BrainReadContext,
  id: string,
  options: { since?: string; limit?: number } = {},
): Promise<{ id: string; entries: BrainTimelineRead[] } | null> {
  const db = ctx.db ?? getDb();
  const { documents } = await getBrainDocuments(ctx, [id]);
  const doc = documents[0];
  if (!doc) return null;
  const limit = clamp(options.limit ?? DEFAULT_TIMELINE_LIMIT, 1, MAX_TIMELINE_LIMIT);
  const since = options.since ? resolveBrainSince(options.since) : null;

  const rows = await db
    .select({
      at: brainTimelineEntries.at,
      evidenceId: brainTimelineEntries.evidenceId,
      summary: brainTimelineEntries.summary,
      detail: brainTimelineEntries.detail,
      sourceRef: brainTimelineEntries.sourceRef,
      sourceTitle: brainTimelineEntries.sourceTitle,
    })
    .from(brainTimelineEntries)
    .where(
      and(
        eq(brainTimelineEntries.brainRef, ctx.brainRef),
        eq(brainTimelineEntries.brainId, doc.id),
        ...(since ? [gte(brainTimelineEntries.at, since)] : []),
      ),
    )
    .orderBy(desc(brainTimelineEntries.at))
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

export async function listBrainDocuments(
  ctx: BrainReadContext,
  options: {
    folder?: string;
    type?: string;
    kind?: BrainKind;
    limit?: number;
    includeMerged?: boolean;
    includeArchived?: boolean;
    includeConflicts?: boolean;
  } = {},
): Promise<BrainDocumentSummary[]> {
  const db = ctx.db ?? getDb();
  const limit = clamp(options.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const conditions = documentFilters(ctx.brainRef, options, 0, Date.now());
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
    BrainSearchOptions,
    "folder" | "type" | "kind" | "since" | "includeMerged" | "includeArchived" | "includeConflicts"
  >,
  hops: number,
  now: number,
): SQL[] {
  const conditions: (SQL | undefined)[] = [eq(brainDocuments.brainRef, brainRef)];
  if (options.folder) {
    conditions.push(
      or(
        eq(brainDocuments.folderPath, options.folder),
        like(brainDocuments.folderPath, `${options.folder}/%`),
      ),
    );
  } else {
    conditions.push(
      and(
        ne(brainDocuments.folderPath, "skills"),
        sql`${brainDocuments.folderPath} NOT LIKE 'skills/%'`,
      ),
    );
  }
  if (options.type) {
    conditions.push(eq(brainDocuments.entityType, options.type as BrainEntityType));
  }
  // CLI parity: graph expansion works over pages; evidence stays reachable via links and the
  // explicit kind filter.
  const kind = options.kind ?? (hops > 0 ? "page" : undefined);
  if (kind) conditions.push(eq(brainDocuments.kind, kind));
  if (options.since) {
    conditions.push(gte(brainDocuments.updatedAt, resolveBrainSince(options.since, now)));
  }
  if (!options.includeMerged) conditions.push(ne(brainDocuments.status, "merged"));
  if (!options.includeArchived) conditions.push(ne(brainDocuments.status, "archived"));
  if (!options.includeConflicts) {
    // A conflict copy declares a conflicts_with relation to the canonical page
    // (see upsertConflictDocument); the projection turns that into a brain_edges
    // row, so exclusion is a plain anti-join.
    conditions.push(
      sql`NOT EXISTS (
        SELECT 1 FROM ${brainEdges} AS conflict_edge
        WHERE conflict_edge.document_id = ${brainDocuments.id}
          AND conflict_edge.relation_type = 'conflicts_with'
          AND conflict_edge.source_kind = 'relation'
      )`,
    );
  }
  return conditions.filter((condition): condition is SQL => condition !== undefined);
}

export function resolveBrainSince(raw: string, now: number = Date.now()): Date {
  const trimmed = raw.trim();
  const relative = RELATIVE_SINCE.exec(trimmed) ?? NATURAL_RELATIVE_SINCE.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = SINCE_UNIT_MS[(relative[2] ?? "").toLowerCase()];
    if (!unitMs || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid "since" value: ${raw}`);
    }
    const timestamp = now - amount * unitMs;
    if (!Number.isFinite(timestamp)) throw new Error(`Invalid "since" value: ${raw}`);
    return new Date(timestamp);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`Invalid "since" value: ${raw}`);
  return new Date(parsed);
}

async function ftsCandidates(db: DbClient, conditions: SQL[], text: string): Promise<string[]> {
  const rank = sql`ts_rank_cd(${brainDocuments.searchTsv}, websearch_to_tsquery('english', ${text}))`;
  const rows: Array<{ id: string }> = await db
    .select({ id: brainDocuments.brainId })
    .from(brainDocuments)
    .where(
      and(
        ...conditions,
        sql`websearch_to_tsquery('english', ${text}) @@ ${brainDocuments.searchTsv}`,
      ),
    )
    .orderBy(desc(rank))
    .limit(FTS_CANDIDATE_LIMIT);
  return rows.map((row) => row.id);
}

async function nameCandidates(db: DbClient, conditions: SQL[], text: string): Promise<string[]> {
  const similarity = sql`word_similarity(${text}, ${brainDocuments.nameText})`;
  const rows: Array<{ id: string }> = await db
    .select({ id: brainDocuments.brainId })
    .from(brainDocuments)
    .where(and(...conditions, sql`${text} <% ${brainDocuments.nameText}`))
    .orderBy(desc(similarity))
    .limit(NAME_CANDIDATE_LIMIT);
  return rows.map((row) => row.id);
}

// Pure cutoff filter, extracted so the distance threshold is unit-testable without a DB harness.
export function filterVectorCandidates(
  rows: VectorCandidate[],
  maxDistance: number,
): VectorCandidate[] {
  return rows.filter((row) => Number.isFinite(row.distance) && row.distance <= maxDistance);
}

function vectorMaxDistance(): number {
  const raw = Number(process.env.GOAT_BRAIN_VECTOR_MAX_DISTANCE);
  return Number.isFinite(raw) && raw > 0 ? raw : VECTOR_MAX_DISTANCE_DEFAULT;
}

async function vectorCandidates(
  db: DbClient,
  ctx: BrainReadContext,
  conditions: SQL[],
  text: string,
): Promise<VectorCandidate[]> {
  // Ranking assist only: any gateway or pgvector failure degrades this list to empty and the
  // query stays lexical, mirroring the CLI's silent degrade.
  try {
    const model = process.env.GOAT_BRAIN_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
    const embeddingJoin = and(
      eq(brainDocumentEmbeddings.documentId, brainDocuments.id),
      eq(brainDocumentEmbeddings.contentHash, brainDocuments.contentHash),
      eq(brainDocumentEmbeddings.model, model),
    );

    const missing: Array<{
      documentId: string;
      contentHash: string;
      title: string | null;
      aliases: string[] | null;
      body: string;
    }> = await db
      .select({
        documentId: brainDocuments.id,
        contentHash: brainDocuments.contentHash,
        title: brainDocuments.title,
        aliases: brainDocuments.aliases,
        body: brainDocuments.body,
      })
      .from(brainDocuments)
      .leftJoin(brainDocumentEmbeddings, embeddingJoin)
      .where(and(...conditions, isNull(brainDocumentEmbeddings.documentId)))
      .limit(EMBED_BACKFILL_LIMIT);

    const gateway = createGateway({
      apiKey: ctx.gatewayApiKey ?? "",
      embeddingModel: model,
      ...(process.env.GOAT_BRAIN_GATEWAY_BASE_URL
        ? { baseUrl: process.env.GOAT_BRAIN_GATEWAY_BASE_URL }
        : {}),
      ...(ctx.reporting ? { reporting: ctx.reporting } : {}),
      ...(ctx.onUsage ? { onUsage: ctx.onUsage } : {}),
    });

    // One embeddings call covers the query and the backfill batch.
    const vectors = await gateway.embed([
      text,
      ...missing.map((doc) => embeddingTextFor(doc.title ?? "", doc.aliases ?? [], doc.body)),
    ]);
    const queryVector = vectors[0];
    if (!queryVector) return [] as VectorCandidate[];

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
        .insert(brainDocumentEmbeddings)
        .values(upserts)
        .onConflictDoUpdate({
          target: brainDocumentEmbeddings.documentId,
          set: {
            contentHash: sql`excluded.content_hash`,
            model: sql`excluded.model`,
            embedding: sql`excluded.embedding`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    const distanceExpr = sql<number>`${brainDocumentEmbeddings.embedding} <=> ${JSON.stringify(queryVector)}::vector`;
    const rows: Array<{ id: string; distance: number }> = await db
      .select({ id: brainDocuments.brainId, distance: distanceExpr })
      .from(brainDocumentEmbeddings)
      .innerJoin(
        brainDocuments,
        and(
          eq(brainDocuments.id, brainDocumentEmbeddings.documentId),
          eq(brainDocuments.contentHash, brainDocumentEmbeddings.contentHash),
        ),
      )
      .where(and(...conditions, eq(brainDocumentEmbeddings.model, model)))
      .orderBy(distanceExpr)
      .limit(VECTOR_CANDIDATE_LIMIT);
    // Distance can arrive as a numeric string over some drivers; coerce before the cutoff.
    const candidates = rows.map((row) => ({ id: row.id, distance: Number(row.distance) }));
    return filterVectorCandidates(candidates, vectorMaxDistance());
  } catch {
    return [] as VectorCandidate[];
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
): Promise<Map<string, ReadPlaneGraphEdge[]>> {
  const rows: Array<{ from: string; to: string; type: string; sourceKind: string }> = await db
    .select({
      from: brainEdges.fromBrainId,
      to: brainEdges.toBrainId,
      type: brainEdges.relationType,
      sourceKind: brainEdges.sourceKind,
    })
    .from(brainEdges)
    .where(eq(brainEdges.brainRef, brainRef));

  const adjacency = new Map<string, ReadPlaneGraphEdge[]>();
  const push = (key: string, hop: ReadPlaneGraphEdge) => {
    const existing = adjacency.get(key);
    if (existing) existing.push(hop);
    else adjacency.set(key, [hop]);
  };
  for (const edge of rows) {
    if (edge.from === edge.to) continue;
    push(edge.from, { ...edge, neighborId: edge.to, direction: "out" });
    push(edge.to, { ...edge, neighborId: edge.from, direction: "in" });
  }
  return adjacency;
}

function expandAlongGraph(
  relevance: Map<string, number>,
  graphPaths: Map<string, BrainGraphHop[]>,
  adjacency: Map<string, ReadPlaneGraphEdge[]>,
  allowed: Set<string>,
  hops: number,
): void {
  let frontier = [...relevance.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GRAPH_SEED_LIMIT)
    .map(([id, score]) => ({ id, score, path: [] as BrainGraphHop[] }));

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: Array<{ id: string; score: number; path: BrainGraphHop[] }> = [];
    for (const { id, score, path } of frontier) {
      const boosted = score * HOP_DECAY;
      for (const edge of adjacency.get(id) ?? []) {
        if (!allowed.has(edge.neighborId)) continue;
        if (boosted > (relevance.get(edge.neighborId) ?? 0)) {
          const nextPath = [...path, { from: id, type: edge.type, to: edge.neighborId }];
          relevance.set(edge.neighborId, boosted);
          graphPaths.set(edge.neighborId, nextPath);
          next.push({ id: edge.neighborId, score: boosted, path: nextPath });
        }
      }
    }
    frontier = next;
  }
}

async function filteredIdSet(db: DbClient, conditions: SQL[]): Promise<Set<string>> {
  const rows: Array<{ id: string }> = await db
    .select({ id: brainDocuments.brainId })
    .from(brainDocuments)
    .where(and(...conditions));
  return new Set(rows.map((row) => row.id));
}

async function fetchNeighbors(
  db: DbClient,
  brainRef: string,
  hitIds: string[],
  preloaded: Map<string, ReadPlaneGraphEdge[]> | null,
): Promise<Map<string, BrainDocumentLink[]>> {
  if (hitIds.length === 0) return new Map();
  const adjacency =
    preloaded ??
    (await (async () => {
      const rows: Array<{ from: string; to: string; type: string; sourceKind: string }> = await db
        .select({
          from: brainEdges.fromBrainId,
          to: brainEdges.toBrainId,
          type: brainEdges.relationType,
          sourceKind: brainEdges.sourceKind,
        })
        .from(brainEdges)
        .where(
          and(
            eq(brainEdges.brainRef, brainRef),
            or(inArray(brainEdges.fromBrainId, hitIds), inArray(brainEdges.toBrainId, hitIds)),
          ),
        );
      const map = new Map<string, ReadPlaneGraphEdge[]>();
      for (const edge of rows) {
        if (edge.from === edge.to) continue;
        pushReadPlaneGraphEdge(map, edge.from, {
          ...edge,
          neighborId: edge.to,
          direction: "out",
        });
        pushReadPlaneGraphEdge(map, edge.to, {
          ...edge,
          neighborId: edge.from,
          direction: "in",
        });
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
): Promise<Map<string, BrainDocumentLink[]>> {
  if (ids.length === 0) return new Map();
  const rows: Array<{ from: string; to: string; type: string; sourceKind: string }> = await db
    .select({
      from: brainEdges.fromBrainId,
      to: brainEdges.toBrainId,
      type: brainEdges.relationType,
      sourceKind: brainEdges.sourceKind,
    })
    .from(brainEdges)
    .where(
      and(
        eq(brainEdges.brainRef, brainRef),
        or(inArray(brainEdges.fromBrainId, ids), inArray(brainEdges.toBrainId, ids)),
      ),
    );
  const adjacency = new Map<string, ReadPlaneGraphEdge[]>();
  for (const edge of rows) {
    if (edge.from === edge.to) continue;
    pushReadPlaneGraphEdge(adjacency, edge.from, {
      ...edge,
      neighborId: edge.to,
      direction: "out",
    });
    pushReadPlaneGraphEdge(adjacency, edge.to, {
      ...edge,
      neighborId: edge.from,
      direction: "in",
    });
  }
  return linksFromAdjacency(db, brainRef, ids, adjacency, limitPerDoc);
}

function pushReadPlaneGraphEdge(
  adjacency: Map<string, ReadPlaneGraphEdge[]>,
  key: string,
  edge: ReadPlaneGraphEdge,
) {
  const existing = adjacency.get(key);
  if (existing) existing.push(edge);
  else adjacency.set(key, [edge]);
}

// Resolve adjacency rows into links: direction from the hit's perspective, titles joined in, and
// targets that do not exist as documents (e.g. dangling wiki links) dropped.
async function linksFromAdjacency(
  db: DbClient,
  brainRef: string,
  ids: string[],
  adjacency: Map<string, ReadPlaneGraphEdge[]>,
  limitPerDoc: number,
): Promise<Map<string, BrainDocumentLink[]>> {
  const targetIds = new Set<string>();
  for (const id of ids) for (const hop of adjacency.get(id) ?? []) targetIds.add(hop.neighborId);
  if (targetIds.size === 0) return new Map();

  const targetRows: Array<{
    id: string;
    title: string | null;
    kind: string;
    type: string;
    folder: string;
    status: string;
  }> = await db
    .select({
      id: brainDocuments.brainId,
      title: brainDocuments.title,
      kind: brainDocuments.kind,
      type: brainDocuments.entityType,
      folder: brainDocuments.folderPath,
      status: brainDocuments.status,
    })
    .from(brainDocuments)
    .where(
      and(eq(brainDocuments.brainRef, brainRef), inArray(brainDocuments.brainId, [...targetIds])),
    );
  const targets = new Map(targetRows.map((row) => [row.id, row]));

  const links = new Map<string, BrainDocumentLink[]>();
  for (const id of ids) {
    const seen = new Set<string>();
    const entries: BrainDocumentLink[] = [];
    for (const hop of adjacency.get(id) ?? []) {
      const target = targets.get(hop.neighborId);
      if (!target) continue;
      const key = `${hop.type}:${hop.sourceKind}:${hop.neighborId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: hop.neighborId,
        title: target.title ?? target.id,
        kind: target.kind,
        type: target.type,
        folder: target.folder,
        status: target.status,
        relationType: hop.type,
        sourceKind: hop.sourceKind,
        direction: hop.direction,
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

type DocumentRow = typeof brainDocuments.$inferSelect;

const documentMetaSelection = {
  brainId: brainDocuments.brainId,
  folderPath: brainDocuments.folderPath,
  title: brainDocuments.title,
  entityType: brainDocuments.entityType,
  kind: brainDocuments.kind,
  status: brainDocuments.status,
  aliases: brainDocuments.aliases,
  updatedAt: brainDocuments.updatedAt,
  snippetSource: sql<string>`left(${brainDocuments.body}, ${SNIPPET_MAX_CHARS + 100})`,
  bodyLength: sql<number>`length(${brainDocuments.body})`,
};

async function fetchDocumentMetaByIds(
  db: DbClient,
  brainRef: string,
  ids: string[],
): Promise<Map<string, DocumentMetaRow>> {
  if (ids.length === 0) return new Map();
  const rows: DocumentMetaRow[] = await db
    .select(documentMetaSelection)
    .from(brainDocuments)
    .where(and(eq(brainDocuments.brainRef, brainRef), inArray(brainDocuments.brainId, ids)));
  return new Map(rows.map((row) => [row.brainId, row]));
}

async function fetchDocumentMetaWhere(
  db: DbClient,
  where: SQL | undefined,
  limit: number,
  offset: number = 0,
): Promise<DocumentMetaRow[]> {
  return db
    .select(documentMetaSelection)
    .from(brainDocuments)
    .where(where)
    .orderBy(desc(brainDocuments.updatedAt), asc(brainDocuments.brainId))
    .offset(offset)
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
    BRAIN_WEIGHT_RELEVANCE * (relevance / maxRelevance) +
    BRAIN_WEIGHT_FRESHNESS * brainFreshness(updatedAt, now)
  );
}

function hitFromMeta(record: DocumentMetaRow, score: number, snippetChars: number): BrainSearchHit {
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
    snippet: snippetFor(record, snippetChars),
    neighbors: [],
  };
}

function snippetFor(record: DocumentMetaRow, maxChars: number): string {
  if (maxChars <= 0) return "";
  const truth = record.snippetSource.trim();
  if (!truth) return "_No compiled truth yet._";
  if (record.bodyLength <= maxChars) return truth;
  return `${truth.slice(0, maxChars).trimEnd()}... [truncated; fetch the full document by id]`;
}

function mergedInto(row: DocumentRow): string | null {
  try {
    return parseBrainDocument(row.content).frontmatter.mergedInto ?? null;
  } catch {
    return null;
  }
}

function addSignal(
  signals: Map<string, Set<BrainSearchSignal>>,
  ids: string[],
  signal: BrainSearchSignal,
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
