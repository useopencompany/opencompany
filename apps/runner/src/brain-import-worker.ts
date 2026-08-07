import { randomUUID } from "node:crypto";
import { executeExaSearchRequest } from "@opencompany/agent-runtime";
import {
  BrainSourceNormalizationError,
  type ImportResearchResult,
  type NormalizedBrainSourceItem,
  normalizeFathomMeeting,
  normalizeGranolaMeetingNote,
  normalizeImportRun,
} from "@opencompany/brain";
import {
  addBrainImportCandidate,
  type BrainImportRun,
  completeBrainImportDiscovery,
  discoverStoredBrainImportCandidates,
  getBrainImportJobProgress,
} from "@opencompany/db/brain-import";
import { upsertBrainSourceItemAndEnqueue } from "@opencompany/db/brain-ingest";
import { GOAT_FATHOM_CREDENTIAL_KIND, GOAT_FATHOM_PROVIDER } from "@opencompany/db/fathom";
import { GOAT_GRANOLA_CREDENTIAL_KIND, GOAT_GRANOLA_PROVIDER } from "@opencompany/db/granola";
import { loadIntegrationCredential } from "@opencompany/db/integrations";
import {
  type BrainImportDiscoverySummary,
  type BrainImportProvider,
  brainImportCandidates,
  brainImportRuns,
  brainIngestJobs,
  brainSourceItems,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { wakeBrainIngestWorker } from "./brain-ingest-worker";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { type FathomMeetingSummary, listFathomMeetings } from "./fathom-api";
import {
  fetchGranolaNote,
  GranolaApiError,
  type GranolaNoteSummary,
  isGranolaAuthError,
  listGranolaNotes,
} from "./granola-api";

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-brain-import",
});
const POLL_INTERVAL_MS = 5_000;
const LEASE_TTL_MS = 3 * 60_000;
const ACTIVE_WORKER_STATUSES = ["discovering", "ingesting", "finalizing"] as const;
const GRANOLA_IMPORT_MAX_LIST_PAGES = 5;
const GRANOLA_IMPORT_MAX_NOTES = 20;
const FATHOM_IMPORT_MAX_LIST_PAGES = 5;
const FATHOM_IMPORT_MAX_MEETINGS = 20;
const PROVIDERS: BrainImportProvider[] = [
  "public_web",
  "github",
  "jamie",
  "granola",
  "fathom",
  "gmail",
  "slack",
  "linear",
];

let registeredWakeup: (() => void) | null = null;

export function setBrainImportWakeup(wake: (() => void) | null) {
  registeredWakeup = wake;
}

export function wakeBrainImportWorker() {
  registeredWakeup?.();
}

export async function processNextBrainImportRun(env: RunnerEnv): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const [run] = await db
    .select()
    .from(brainImportRuns)
    .where(
      and(
        inArray(brainImportRuns.status, ACTIVE_WORKER_STATUSES),
        lte(brainImportRuns.nextRunAt, now),
        or(isNull(brainImportRuns.leaseId), lt(brainImportRuns.leaseExpiresAt, now)),
      ),
    )
    .orderBy(brainImportRuns.nextRunAt)
    .limit(1);
  if (!run) return false;

  const leaseId = randomUUID();
  const [claimed] = await db
    .update(brainImportRuns)
    .set({
      leaseId,
      leaseOwner: env.instanceId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(brainImportRuns.id, run.id),
        inArray(brainImportRuns.status, ACTIVE_WORKER_STATUSES),
        lte(brainImportRuns.nextRunAt, now),
        or(isNull(brainImportRuns.leaseId), lt(brainImportRuns.leaseExpiresAt, now)),
      ),
    )
    .returning();
  if (!claimed) return true;

  try {
    if (claimed.status === "discovering") await discoverImport(claimed, env);
    else if (claimed.status === "ingesting") await monitorChildren(claimed);
    else if (claimed.status === "finalizing") await finishImport(claimed);
  } catch (error) {
    captureException(error, {
      event: "opencompany.goat_brain_import_failed",
      import_run_id: run.id,
    });
    await db
      .update(brainImportRuns)
      .set({
        status: "failed",
        lastError: error instanceof Error ? error.message : String(error),
        completedAt: new Date(),
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(brainImportRuns.id, run.id), eq(brainImportRuns.leaseId, leaseId)));
  }
  return true;
}

async function discoverImport(run: BrainImportRun, env: RunnerEnv) {
  if (!run.leaseId) throw new Error("Import discovery lease is missing.");
  const db = getDb();
  const summary: BrainImportDiscoverySummary = {};
  for (const provider of PROVIDERS) {
    if (!(await renewImportLease(run, "discovering"))) return;
    const selection = run.sourceSelection[provider];
    if (!selection?.enabled) {
      summary[provider] = emptyProvider("unavailable");
      continue;
    }
    try {
      if (provider === "public_web") {
        summary[provider] = await discoverPublicResearch(run, env);
      } else {
        if (provider === "granola") await hydrateGranolaImportSourceItems(run);
        if (provider === "fathom") await hydrateFathomImportSourceItems(run);
        const counts = await discoverStoredBrainImportCandidates({
          run,
          provider,
          db,
        });
        summary[provider] = {
          status: "ready",
          discoveredEntries: counts.discoveredEntries,
          eligibleEntries: counts.eligibleEntries,
          alreadyKnownEntries: counts.alreadyKnownEntries,
          selectedEntries: counts.selectedEntries,
          plannedRuns: counts.selectedEntries,
        };
      }
    } catch (error) {
      summary[provider] = {
        ...emptyProvider("failed"),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  await completeBrainImportDiscovery({
    importRunId: run.id,
    leaseId: run.leaseId,
    discoverySummary: summary,
    db,
  });
}

async function hydrateGranolaImportSourceItems(run: BrainImportRun) {
  const selection = run.sourceSelection.granola;
  if (!selection?.enabled || !selection.integrationId) return;
  const credential = await loadIntegrationCredential({
    userWorkosId: run.userWorkosId,
    integrationId: selection.integrationId,
    provider: GOAT_GRANOLA_PROVIDER,
    kind: GOAT_GRANOLA_CREDENTIAL_KIND,
  });
  const apiKey =
    credential && typeof credential.payload.apiKey === "string" ? credential.payload.apiKey : null;
  if (!apiKey) throw new Error("The saved Granola API key could not be loaded.");

  const notes: GranolaNoteSummary[] = [];
  let cursor: string | undefined;
  let truncated = false;
  const seenCursors = new Set<string>();
  for (let page = 0; page < GRANOLA_IMPORT_MAX_LIST_PAGES; page += 1) {
    if (!(await renewImportLease(run, "discovering"))) {
      throw new Error("Import discovery lease was lost.");
    }
    const result = await listGranolaNotes({
      apiKey,
      createdAfter: run.historyStartAt.toISOString(),
      createdBefore: run.historyEndAt.toISOString(),
      ...(cursor ? { cursor } : {}),
    });
    notes.push(...result.notes);
    if (!result.hasMore) break;
    if (!result.cursor || seenCursors.has(result.cursor)) {
      throw new Error("Granola returned an invalid pagination cursor during context import.");
    }
    seenCursors.add(result.cursor);
    cursor = result.cursor;
    truncated = page === GRANOLA_IMPORT_MAX_LIST_PAGES - 1;
  }
  if (truncated) {
    logger.info("Granola context import reached its bounded note-list limit", {
      event: "opencompany.goat_brain_import_granola_list_limited",
      import_run_id: run.id,
      listed_note_count: notes.length,
    });
  }

  const candidates = selectGranolaImportNotes(notes);
  for (const note of candidates) {
    if (!(await renewImportLease(run, "discovering"))) {
      throw new Error("Import discovery lease was lost.");
    }
    try {
      const payload = await fetchGranolaNote({ apiKey, noteId: note.id });
      const item = normalizeGranolaMeetingNote(payload, { capturedAt: new Date().toISOString() });
      await upsertBrainSourceItemAndEnqueue({
        userWorkosId: run.userWorkosId,
        sourceConnectionId: selection.integrationId,
        integrationId: selection.integrationId,
        item,
        rawPayload: payload,
        brainRefs: [],
      });
    } catch (error) {
      if (isGranolaAuthError(error)) throw error;
      if (error instanceof GranolaApiError && error.status !== 404) throw error;
      if (
        !(error instanceof GranolaApiError) &&
        !(error instanceof BrainSourceNormalizationError)
      ) {
        throw error;
      }
      logger.warn("Skipped unavailable Granola note during context import", {
        event: "opencompany.goat_brain_import_granola_note_skipped",
        import_run_id: run.id,
        note_id: note.id,
        reason: error instanceof GranolaApiError ? "not_found" : "invalid_payload",
      });
    }
  }
}

async function hydrateFathomImportSourceItems(run: BrainImportRun) {
  const selection = run.sourceSelection.fathom;
  if (!selection?.enabled || !selection.integrationId) return;
  const credential = await loadIntegrationCredential({
    userWorkosId: run.userWorkosId,
    integrationId: selection.integrationId,
    provider: GOAT_FATHOM_PROVIDER,
    kind: GOAT_FATHOM_CREDENTIAL_KIND,
  });
  const apiKey =
    credential && typeof credential.payload.apiKey === "string" ? credential.payload.apiKey : null;
  if (!apiKey) throw new Error("The saved Fathom API key could not be loaded.");

  // The Fathom list call carries transcript, summary, and action items inline,
  // so hydration is a single bounded listing pass with no per-item fetch.
  const meetings: FathomMeetingSummary[] = [];
  let cursor: string | undefined;
  let truncated = false;
  const seenCursors = new Set<string>();
  for (let page = 0; page < FATHOM_IMPORT_MAX_LIST_PAGES; page += 1) {
    if (!(await renewImportLease(run, "discovering"))) {
      throw new Error("Import discovery lease was lost.");
    }
    const result = await listFathomMeetings({
      apiKey,
      createdAfter: run.historyStartAt.toISOString(),
      createdBefore: run.historyEndAt.toISOString(),
      ...(cursor ? { cursor } : {}),
    });
    meetings.push(...result.meetings);
    if (!result.nextCursor) break;
    if (seenCursors.has(result.nextCursor)) {
      throw new Error("Fathom returned an invalid pagination cursor during context import.");
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
    truncated = page === FATHOM_IMPORT_MAX_LIST_PAGES - 1;
  }
  if (truncated) {
    logger.info("Fathom context import reached its bounded meeting-list limit", {
      event: "opencompany.goat_brain_import_fathom_list_limited",
      import_run_id: run.id,
      listed_meeting_count: meetings.length,
    });
  }

  const candidates = selectFathomImportMeetings(meetings);
  for (const meeting of candidates) {
    if (!(await renewImportLease(run, "discovering"))) {
      throw new Error("Import discovery lease was lost.");
    }
    try {
      const item = normalizeFathomMeeting(meeting.raw, {
        capturedAt: new Date().toISOString(),
      });
      await upsertBrainSourceItemAndEnqueue({
        userWorkosId: run.userWorkosId,
        sourceConnectionId: selection.integrationId,
        integrationId: selection.integrationId,
        item,
        rawPayload: meeting.raw,
        brainRefs: [],
      });
    } catch (error) {
      if (!(error instanceof BrainSourceNormalizationError)) throw error;
      logger.warn("Skipped invalid Fathom meeting during context import", {
        event: "opencompany.goat_brain_import_fathom_meeting_skipped",
        import_run_id: run.id,
        recording_id: meeting.recordingId,
        reason: "invalid_payload",
      });
    }
  }
}

export function selectFathomImportMeetings(
  meetings: readonly FathomMeetingSummary[],
  limit = FATHOM_IMPORT_MAX_MEETINGS,
) {
  const byId = new Map<string, FathomMeetingSummary>();
  for (const meeting of meetings) {
    const existing = byId.get(meeting.recordingId);
    if (!existing || timestamp(meeting.createdAt) > timestamp(existing.createdAt)) {
      byId.set(meeting.recordingId, meeting);
    }
  }
  return [...byId.values()]
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))
    .slice(0, limit);
}

export function selectGranolaImportNotes(
  notes: readonly GranolaNoteSummary[],
  limit = GRANOLA_IMPORT_MAX_NOTES,
) {
  const byId = new Map<string, GranolaNoteSummary>();
  for (const note of notes) {
    const existing = byId.get(note.id);
    if (!existing || timestamp(note.updatedAt) > timestamp(existing.updatedAt)) {
      byId.set(note.id, note);
    }
  }
  return [...byId.values()]
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))
    .slice(0, limit);
}

function timestamp(value: string | null) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function discoverPublicResearch(run: BrainImportRun, env: RunnerEnv) {
  if (!env.exaApiKey)
    throw new Error("Public research is unavailable because Exa is not configured.");
  const queries: Array<{
    query: string;
    category: "company" | "people" | "general";
  }> = [
    { query: `${run.companyDomain} company`, category: "company" },
    {
      query: `site:${run.companyDomain} about team company`,
      category: "general",
    },
    {
      query: `site:${run.companyDomain} product customers`,
      category: "general",
    },
    { query: `site:${run.companyDomain} blog news`, category: "general" },
    { query: `${run.companyDomain} founders leadership`, category: "people" },
  ];
  const results = new Map<string, ImportResearchResult>();
  for (const search of queries) {
    if (!(await renewImportLease(run, "discovering"))) {
      throw new Error("Import discovery lease was lost.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await executeExaSearchRequest({
        apiKey: env.exaApiKey,
        args: {
          query: search.query,
          ...(search.category === "general" ? {} : { category: search.category }),
          numResults: 8,
        },
        signal: controller.signal,
      });
      for (const result of response.output.results) {
        if (!result.url || !result.title) continue;
        const url = canonicalPublicUrl(result.url);
        if (!url || results.has(url)) continue;
        results.set(url, {
          title: result.title,
          url,
          ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
          ...(result.author ? { author: redactPersonalContactData(result.author) } : {}),
          highlights: (result.highlights ?? []).map(redactPersonalContactData),
          ...(result.summary ? { summary: redactPersonalContactData(result.summary) } : {}),
        });
        if (results.size >= 40) break;
      }
    } finally {
      clearTimeout(timeout);
    }
    if (results.size >= 40) break;
  }
  if (!(await renewImportLease(run, "discovering"))) {
    throw new Error("Import discovery lease was lost.");
  }
  const item = normalizeImportRun({
    phase: "research",
    importRunId: run.id,
    companyUrl: run.companyUrl,
    companyDomain: run.companyDomain,
    ...(run.companyName ? { companyName: run.companyName } : {}),
    ...(run.focus ? { focus: run.focus } : {}),
    searches: queries,
    results: Array.from(results.values()),
  });
  const persisted = await upsertBrainSourceItemAndEnqueue({
    userWorkosId: run.userWorkosId,
    sourceConnectionId: run.id,
    item,
    rawPayload: item.content,
    kind: "brain_agent_ingest",
    brainRefs: [],
  });
  await addBrainImportCandidate({
    importRunId: run.id,
    provider: "public_web",
    sourceItemId: persisted.sourceItemId,
    entryCount: results.size,
    rank: -1,
    selected: results.size > 0,
  });
  return {
    status: "ready" as const,
    discoveredEntries: results.size,
    eligibleEntries: results.size,
    alreadyKnownEntries: 0,
    selectedEntries: results.size,
    plannedRuns: results.size > 0 ? 1 : 0,
    searchCount: queries.length,
    resultCount: results.size,
  };
}

async function monitorChildren(run: BrainImportRun) {
  const db = getDb();
  await enqueuePendingCandidates(run);
  const progress = await getBrainImportJobProgress(run.id, db);
  if (!progress.terminal) {
    await releaseForPoll(run, "ingesting");
    return;
  }
  const childSummary = progress.rows.map((row) => {
    const summary = jobSummary(row);
    return {
      provider: importProviderForJob(row),
      status: row.status as "succeeded" | "failed" | "skipped",
      ...(summary ? { summary } : {}),
    };
  });
  const item = normalizeImportRun({
    phase: "finalize",
    importRunId: run.id,
    companyUrl: run.companyUrl,
    companyDomain: run.companyDomain,
    ...(run.companyName ? { companyName: run.companyName } : {}),
    ...(run.focus ? { focus: run.focus } : {}),
    childSummary,
  });
  if (!run.leaseId) return;
  const leaseId = run.leaseId;
  const enqueued = await db.transaction(async (tx) => {
    const [transitioned] = await tx
      .update(brainImportRuns)
      .set({ status: "finalizing", updatedAt: new Date() })
      .where(
        and(
          eq(brainImportRuns.id, run.id),
          eq(brainImportRuns.status, "ingesting"),
          eq(brainImportRuns.leaseId, leaseId),
        ),
      )
      .returning({ id: brainImportRuns.id });
    if (!transitioned) return false;

    await upsertBrainSourceItemAndEnqueue({
      userWorkosId: run.userWorkosId,
      sourceConnectionId: run.id,
      item,
      rawPayload: item.content,
      kind: "brain_agent_ingest",
      importRunId: run.id,
      brainRef: run.brainRef,
      db: tx,
    });
    await tx
      .update(brainImportRuns)
      .set({
        result: { childSummary },
        nextRunAt: new Date(Date.now() + POLL_INTERVAL_MS),
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(brainImportRuns.id, run.id),
          eq(brainImportRuns.status, "finalizing"),
          eq(brainImportRuns.leaseId, leaseId),
        ),
      );
    return true;
  });
  if (enqueued) wakeBrainIngestWorker();
}

async function enqueuePendingCandidates(run: BrainImportRun) {
  if (!run.leaseId) throw new Error("Import ingestion lease is missing.");
  const leaseId = run.leaseId;
  const db = getDb();
  const candidates = await db
    .select({
      id: brainImportCandidates.id,
      sourceItemId: brainSourceItems.id,
      userWorkosId: brainSourceItems.userWorkosId,
      sourceConnectionId: brainSourceItems.sourceConnectionId,
      integrationId: brainSourceItems.integrationId,
      contentHash: brainSourceItems.contentHash,
      rawPayload: brainSourceItems.rawPayload,
      normalizedPayload: brainSourceItems.normalizedPayload,
      rawEventCount: brainSourceItems.rawEventCount,
    })
    .from(brainImportCandidates)
    .innerJoin(brainSourceItems, eq(brainSourceItems.id, brainImportCandidates.sourceItemId))
    .where(
      and(
        eq(brainImportCandidates.importRunId, run.id),
        eq(brainImportCandidates.selected, true),
        isNull(brainImportCandidates.ingestJobId),
      ),
    )
    .orderBy(asc(brainImportCandidates.rank), asc(brainImportCandidates.createdAt));

  for (const candidate of candidates) {
    const enqueued = await db.transaction(async (tx) => {
      const [activeRun] = await tx
        .update(brainImportRuns)
        .set({
          leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(brainImportRuns.id, run.id),
            eq(brainImportRuns.status, "ingesting"),
            eq(brainImportRuns.leaseId, leaseId),
          ),
        )
        .returning({ id: brainImportRuns.id });
      if (!activeRun) return false;

      const result = await upsertBrainSourceItemAndEnqueue({
        userWorkosId: candidate.userWorkosId,
        sourceConnectionId: candidate.sourceConnectionId,
        integrationId: candidate.integrationId,
        item: candidate.normalizedPayload as NormalizedBrainSourceItem,
        rawPayload: candidate.rawPayload,
        rawEventCount: candidate.rawEventCount,
        kind: "brain_agent_ingest",
        importRunId: run.id,
        brainRef: run.brainRef,
        db: tx,
      });
      let jobId = result.jobId;
      if (!jobId) {
        const [existingJob] = await tx
          .select({ id: brainIngestJobs.id })
          .from(brainIngestJobs)
          .where(
            and(
              eq(brainIngestJobs.sourceItemId, candidate.sourceItemId),
              eq(brainIngestJobs.contentHash, candidate.contentHash),
              eq(brainIngestJobs.kind, "brain_agent_ingest"),
              eq(brainIngestJobs.brainRef, run.brainRef),
            ),
          )
          .limit(1);
        jobId = existingJob?.id ?? null;
      }
      if (!jobId) throw new Error(`Could not enqueue import candidate ${candidate.id}.`);
      await tx
        .update(brainIngestJobs)
        .set({ importRunId: run.id, updatedAt: new Date() })
        .where(eq(brainIngestJobs.id, jobId));
      await tx
        .update(brainImportCandidates)
        .set({ ingestJobId: jobId, updatedAt: new Date() })
        .where(
          and(
            eq(brainImportCandidates.id, candidate.id),
            isNull(brainImportCandidates.ingestJobId),
          ),
        );
      return true;
    });
    if (!enqueued) throw new Error("Import ingestion lease was lost while enqueueing candidates.");
  }
  if (candidates.length > 0) wakeBrainIngestWorker();
}

async function finishImport(run: BrainImportRun) {
  const db = getDb();
  const progress = await getBrainImportJobProgress(run.id, db);
  const finalizer = progress.rows.find(isFinalizerJob);
  if (!finalizer || !["succeeded", "failed", "skipped"].includes(finalizer.status)) {
    await releaseForPoll(run, "finalizing");
    return;
  }
  const useful = progress.rows.some((row) => !isFinalizerJob(row) && row.status === "succeeded");
  const failed = progress.rows.some((row) => row.status === "failed");
  const status = failed ? (useful ? "partial" : "failed") : "succeeded";
  const jobs = progress.rows.map((row) => {
    const summary = jobSummary(row);
    return {
      provider: importProviderForJob(row),
      status: row.status,
      ...(summary ? { summary } : {}),
    };
  });
  if (!run.leaseId) return;
  const leaseId = run.leaseId;
  await db
    .update(brainImportRuns)
    .set({
      status,
      result: { ...run.result, jobs },
      completedAt: new Date(),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(brainImportRuns.id, run.id),
        eq(brainImportRuns.status, "finalizing"),
        eq(brainImportRuns.leaseId, leaseId),
      ),
    );
}

function isFinalizerJob(row: { sourceRef: string }) {
  return row.sourceRef.endsWith(":finalize");
}

function importProviderForJob(row: { provider: string; sourceRef: string }) {
  return row.sourceRef.endsWith(":research") ? "public_web" : row.provider;
}

function jobSummary(row: { result: Record<string, unknown>; lastError: string | null }) {
  return typeof row.result.summary === "string" && row.result.summary.trim()
    ? row.result.summary.slice(0, 1_000)
    : row.lastError?.slice(0, 1_000);
}

async function releaseForPoll(run: BrainImportRun, status: "ingesting" | "finalizing") {
  if (!run.leaseId) return;
  const leaseId = run.leaseId;
  await getDb()
    .update(brainImportRuns)
    .set({
      status,
      nextRunAt: new Date(Date.now() + POLL_INTERVAL_MS),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(brainImportRuns.id, run.id),
        eq(brainImportRuns.status, status),
        eq(brainImportRuns.leaseId, leaseId),
      ),
    );
}

async function renewImportLease(
  run: BrainImportRun,
  status: "discovering" | "ingesting" | "finalizing",
) {
  if (!run.leaseId) return false;
  const [renewed] = await getDb()
    .update(brainImportRuns)
    .set({
      leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(brainImportRuns.id, run.id),
        eq(brainImportRuns.status, status),
        eq(brainImportRuns.leaseId, run.leaseId),
      ),
    )
    .returning({ id: brainImportRuns.id });
  return Boolean(renewed);
}

function emptyProvider(status: "unavailable" | "failed") {
  return {
    status,
    discoveredEntries: 0,
    eligibleEntries: 0,
    alreadyKnownEntries: 0,
    selectedEntries: 0,
    plannedRuns: 0,
  } as const;
}

function canonicalPublicUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.startsWith("utm_") || key === "gclid" || key === "fbclid")
        url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function redactPersonalContactData(value: string) {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email removed]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone removed]");
}

export function startBrainImportWorker(env: RunnerEnv) {
  let stopped = false;
  let active = 0;
  let wake: (() => void) | null = null;
  let pendingNotification = false;
  const notify = () => {
    if (wake) wake();
    else pendingNotification = true;
  };
  const loop = (async () => {
    while (!stopped) {
      let processed = false;
      try {
        active += 1;
        processed = await processNextBrainImportRun(env);
      } catch (error) {
        logger.error("Goat Brain import worker failed", { error });
      } finally {
        active -= 1;
      }
      if (stopped) break;
      if (processed) continue;
      if (pendingNotification) {
        pendingNotification = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finishWait = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        const timer = setTimeout(finishWait, POLL_INTERVAL_MS);
        wake = finishWait;
      });
    }
  })();
  return {
    notify,
    activeCount: () => active,
    stop: async () => {
      stopped = true;
      notify();
      await loop;
    },
  };
}
