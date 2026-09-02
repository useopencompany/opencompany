import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { type Actor, CoreError } from "@opencompany/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  type BrainImportDiscoverySummary,
  type BrainImportProvider,
  type BrainImportSourceSelection,
  brainImportCandidates,
  brainImportRuns,
  brainIngestJobs,
  brainSourceItems,
  knowledgeCommandIdempotency,
} from "./product-schema";

type DbLike = any;

const IMPORT_TERMINAL_JOB_STATUSES = ["succeeded", "failed", "skipped"] as const;

export type BrainImportRun = typeof brainImportRuns.$inferSelect;

export function normalizeCompanyUrl(value: string): {
  url: string;
  domain: string;
} {
  const raw = value.trim();
  if (!raw) throw new Error("Enter the company website.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Enter a valid company website.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Company websites must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password)
    throw new Error("Company website credentials are invalid.");
  const domain = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!domain || isUnsafeHostname(domain)) {
    throw new Error("Enter a public company website.");
  }
  const port = parsed.port ? `:${parsed.port}` : "";
  return { url: `${parsed.protocol}//${domain}${port}`, domain };
}

// Durable start command for the canonical API. The reservation makes retries return the original
// run, and the existing single-active-import unique index remains the arbiter for concurrent
// first requests. Neon's HTTP driver has no transactions, so a crash between the reservation and
// the insert is recovered by the replay path creating the run under the reserved ID.
export async function startBrainImportRunIdempotent(input: {
  actor: Actor;
  brainRef: string;
  idempotencyKey: string;
  companyUrl: string;
  focus?: string | null;
  sourceSelection: BrainImportSourceSelection;
  now?: Date;
  db?: DbLike;
}): Promise<{ run: BrainImportRun; idempotentReplay: boolean }> {
  const db = input.db ?? getDb();
  const company = normalizeCompanyUrl(input.companyUrl);
  const operation = "brain_import.start" as const;
  const focus = input.focus?.trim() || null;
  const requestHash = createHash("sha256")
    .update(
      stableImportJson({
        operation,
        command: {
          brainRef: input.brainRef,
          companyUrl: company.url,
          focus,
          sourceSelection: input.sourceSelection,
        },
      }),
    )
    .digest("hex");
  const [reservation] = await db
    .insert(knowledgeCommandIdempotency)
    .values({
      commandId: deterministicImportId("goat_knowledge_command", input.actor, input.idempotencyKey),
      userWorkosId: input.actor.userId,
      workspaceId: input.actor.workspaceId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      operation,
      resourceId: deterministicImportId("gbimp", input.actor, input.idempotencyKey),
    })
    .onConflictDoUpdate({
      target: [
        knowledgeCommandIdempotency.userWorkosId,
        knowledgeCommandIdempotency.workspaceId,
        knowledgeCommandIdempotency.idempotencyKey,
      ],
      set: { touchedAt: new Date() },
    })
    .returning({
      requestHash: knowledgeCommandIdempotency.requestHash,
      operation: knowledgeCommandIdempotency.operation,
      resourceId: knowledgeCommandIdempotency.resourceId,
    });
  if (!reservation) throw new CoreError("conflict", "Could not reserve the import command.");
  if (reservation.operation !== operation || reservation.requestHash !== requestHash) {
    throw new CoreError(
      "idempotency_conflict",
      "The Idempotency-Key was already used for another command.",
    );
  }

  const replay = await findBrainImportRun(reservation.resourceId, input.brainRef, db);
  if (replay) return { run: replay, idempotentReplay: true };

  const now = input.now ?? new Date();
  try {
    const [run] = await db
      .insert(brainImportRuns)
      .values({
        id: reservation.resourceId,
        brainRef: input.brainRef,
        userWorkosId: input.actor.userId,
        companyUrl: company.url,
        companyDomain: company.domain,
        focus,
        historyStartAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        historyEndAt: now,
        sourceSelection: input.sourceSelection,
        status: "discovering",
        nextRunAt: now,
        updatedAt: now,
      })
      .returning();
    if (!run) throw new CoreError("unavailable", "Could not start the company-context scan.");
    return { run, idempotentReplay: false };
  } catch (error) {
    if (!isImportUniqueViolation(error)) throw error;
    // Either a concurrent identical retry won the insert, or another import is still active.
    const winner = await findBrainImportRun(reservation.resourceId, input.brainRef, db);
    if (winner) return { run: winner, idempotentReplay: true };
    throw new CoreError("conflict", "An import is already running for this brain.");
  }
}

async function findBrainImportRun(
  runId: string,
  brainRef: string,
  db: DbLike,
): Promise<BrainImportRun | null> {
  const [run] = await db
    .select()
    .from(brainImportRuns)
    .where(and(eq(brainImportRuns.id, runId), eq(brainImportRuns.brainRef, brainRef)))
    .limit(1);
  return run ?? null;
}

function deterministicImportId(prefix: string, actor: Actor, key: string) {
  const digest = createHash("sha256")
    .update([prefix, actor.userId, actor.workspaceId, key].join("\n"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function stableImportJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableImportJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableImportJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Depending on the driver, drizzle may surface the Postgres error directly or wrap it in a
// DrizzleQueryError whose `cause` carries the SQLSTATE.
function isImportUniqueViolation(error: unknown) {
  for (
    let current = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause ?? null
  ) {
    if ((current as { code?: string }).code === "23505") return true;
  }
  return false;
}

export async function addBrainImportCandidate(input: {
  importRunId: string;
  provider: BrainImportProvider;
  sourceItemId: string;
  entryCount?: number;
  rank?: number;
  selected?: boolean;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const [candidate] = await db
    .insert(brainImportCandidates)
    .values({
      id: `gbimpc_${randomUUID().replace(/-/g, "")}`,
      importRunId: input.importRunId,
      provider: input.provider,
      sourceItemId: input.sourceItemId,
      entryCount: input.entryCount ?? 1,
      rank: input.rank ?? 0,
      selected: input.selected ?? true,
    })
    .onConflictDoUpdate({
      target: [brainImportCandidates.importRunId, brainImportCandidates.sourceItemId],
      set: {
        provider: input.provider,
        entryCount: input.entryCount ?? 1,
        rank: input.rank ?? 0,
        selected: input.selected ?? true,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!candidate) throw new Error("Could not persist an import candidate.");
  return candidate;
}

export async function discoverStoredBrainImportCandidates(input: {
  run: BrainImportRun;
  provider: Exclude<BrainImportProvider, "public_web">;
  limit?: number;
  db?: DbLike;
}): Promise<{
  discoveredEntries: number;
  eligibleEntries: number;
  alreadyKnownEntries: number;
  selectedEntries: number;
}> {
  const db = input.db ?? getDb();
  const selection = input.run.sourceSelection[input.provider];
  if (!selection?.enabled)
    return {
      discoveredEntries: 0,
      eligibleEntries: 0,
      alreadyKnownEntries: 0,
      selectedEntries: 0,
    };
  const sourceProvider = input.provider;
  if (!selection.integrationId) {
    throw new Error(`Import source ${input.provider} is missing its integration.`);
  }
  const filters = [
    eq(brainSourceItems.sourceProvider, sourceProvider),
    eq(brainSourceItems.integrationId, selection.integrationId),
    sql`${brainSourceItems.occurredAt} >= ${input.run.historyStartAt}`,
    sql`${brainSourceItems.occurredAt} <= ${input.run.historyEndAt}`,
  ];
  const discoveredRows = await db
    .select({
      id: brainSourceItems.id,
      occurredAt: brainSourceItems.occurredAt,
      normalizedPayload: brainSourceItems.normalizedPayload,
    })
    .from(brainSourceItems)
    .where(and(...filters))
    .orderBy(desc(brainSourceItems.occurredAt))
    .limit(500);
  const rows = discoveredRows
    .filter((row: { normalizedPayload: unknown }) =>
      matchesBrainImportSelectedScope(input.provider, row.normalizedPayload, selection.config),
    )
    .slice(0, 50);
  if (rows.length === 0)
    return {
      discoveredEntries: 0,
      eligibleEntries: 0,
      alreadyKnownEntries: 0,
      selectedEntries: 0,
    };

  const existingJobs = await db
    .select({ sourceItemId: brainIngestJobs.sourceItemId })
    .from(brainIngestJobs)
    .where(
      and(
        eq(brainIngestJobs.brainRef, input.run.brainRef),
        inArray(
          brainIngestJobs.sourceItemId,
          rows.map((row: { id: string }) => row.id),
        ),
      ),
    );
  const known = new Set(existingJobs.map((row: { sourceItemId: string }) => row.sourceItemId));
  const eligible = rows
    .filter((row: { id: string; normalizedPayload: unknown }) => !known.has(row.id))
    .map((row: { id: string; occurredAt: Date; normalizedPayload: unknown }) => ({
      ...row,
      score: rankStoredBrainImportCandidate(input.provider, row.normalizedPayload),
    }))
    .filter((row: { score: number }) => Number.isFinite(row.score))
    .sort(
      (left: { score: number; occurredAt: Date }, right: { score: number; occurredAt: Date }) =>
        right.score - left.score || right.occurredAt.getTime() - left.occurredAt.getTime(),
    );
  const selected = eligible.slice(0, input.limit ?? 3);
  for (const [rank, row] of selected.entries()) {
    await addBrainImportCandidate({
      importRunId: input.run.id,
      provider: input.provider,
      sourceItemId: row.id,
      rank,
      db,
    });
  }
  return {
    discoveredEntries: rows.length,
    eligibleEntries: eligible.length,
    alreadyKnownEntries: known.size,
    selectedEntries: selected.length,
  };
}

export async function completeBrainImportDiscovery(input: {
  importRunId: string;
  leaseId: string;
  discoverySummary: BrainImportDiscoverySummary;
  companyName?: string | null;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const [run] = await db
    .update(brainImportRuns)
    .set({
      status: "awaiting_confirmation",
      discoverySummary: input.discoverySummary,
      ...(input.companyName ? { companyName: input.companyName } : {}),
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(brainImportRuns.id, input.importRunId),
        eq(brainImportRuns.status, "discovering"),
        eq(brainImportRuns.leaseId, input.leaseId),
      ),
    )
    .returning();
  if (!run) throw new Error("Import discovery is no longer active.");
  return run;
}

export async function confirmBrainImport(input: {
  importRunId: string;
  brainRef: string;
  enabledProviders: BrainImportProvider[];
  actingUserWorkosId: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const enabledProviders = JSON.stringify(input.enabledProviders);
  const result = await db.execute(sql`
    WITH confirmed_run AS (
      UPDATE goat.brain_import_runs
      SET status = 'ingesting',
          confirmed_at = now(),
          next_run_at = now(),
          updated_at = now()
      WHERE id = ${input.importRunId}
        AND brain_ref = ${input.brainRef}
        AND status = 'awaiting_confirmation'
      RETURNING id, brain_ref, user_workos_id, source_selection
    ),
    disabled_candidates AS (
      UPDATE goat.brain_import_candidates AS candidate
      SET selected = false, updated_at = now()
      FROM confirmed_run AS run
      WHERE candidate.import_run_id = run.id
        AND candidate.provider NOT IN (
          SELECT value FROM jsonb_array_elements_text(${enabledProviders}::jsonb) AS value
        )
      RETURNING candidate.id
    ),
    configured_sources AS (
      INSERT INTO goat.brain_sources (
        id, brain_id, provider, integration_id, user_workos_id,
        created_by_workos_id, enabled, config, updated_at
      )
      SELECT
        'gbscfg_' || md5(run.id || ':' || integration.id),
        run.brain_ref,
        source.provider,
        integration.id,
        integration.user_workos_id,
        ${input.actingUserWorkosId},
        true,
        COALESCE(source.selection->'config', '{}'::jsonb),
        now()
      FROM confirmed_run AS run
      INNER JOIN goat.brains AS brain ON brain.id = run.brain_ref
      CROSS JOIN LATERAL jsonb_each(run.source_selection) AS source(provider, selection)
      INNER JOIN goat.integrations AS integration
        ON integration.id = source.selection->>'integrationId'
       AND integration.provider = source.provider
       AND (
         (source.provider IN ('github', 'jamie') AND integration.workspace_id = brain.workspace_id)
         OR
         (source.provider NOT IN ('github', 'jamie')
           AND integration.workspace_id IS NULL
           AND integration.user_workos_id = run.user_workos_id)
       )
      WHERE source.provider <> 'public_web'
        AND COALESCE((source.selection->>'enabled')::boolean, false)
        AND source.provider IN (
          SELECT value FROM jsonb_array_elements_text(${enabledProviders}::jsonb) AS value
        )
      ON CONFLICT (brain_id, integration_id) DO UPDATE
      SET enabled = true,
          config = excluded.config,
          updated_at = now()
      RETURNING id
    )
    SELECT
      run.id AS "importRunId",
      0::integer AS enqueued
    FROM confirmed_run AS run
  `);
  const row = rowsFromExecute<{ importRunId: string; enqueued: number }>(result)[0];
  if (!row) {
    throw new CoreError(
      "conflict",
      "This company-context scan is no longer awaiting confirmation.",
    );
  }
  return row;
}

export async function cancelBrainImport(input: {
  importRunId: string;
  brainRef: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const result = await db.execute(sql`
    WITH canceled_run AS (
      UPDATE goat.brain_import_runs
      SET status = 'canceled',
          completed_at = now(),
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = ${input.importRunId}
        AND brain_ref = ${input.brainRef}
        AND status IN ('discovering', 'awaiting_confirmation', 'ingesting', 'finalizing')
      RETURNING id
    ),
    skipped_jobs AS (
      UPDATE goat.brain_ingest_jobs AS job
      SET status = 'skipped',
          completed_at = now(),
          result = jsonb_build_object(
            'skipped', true,
            'reason', 'Import canceled',
            'summary', 'Import canceled'
          ),
          updated_at = now()
      FROM canceled_run AS run
      WHERE job.import_run_id = run.id
        AND job.status = 'queued'
      RETURNING job.id
    )
    SELECT
      run.id AS "importRunId",
      (SELECT count(*)::integer FROM skipped_jobs) AS "skippedJobs"
    FROM canceled_run AS run
  `);
  const row = rowsFromExecute<{ importRunId: string; skippedJobs: number }>(result)[0];
  if (!row) throw new CoreError("conflict", "This import is no longer active.");
  return row;
}

export async function retryBrainImportDiscovery(input: {
  importRunId: string;
  brainRef: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const result = await db.execute(sql`
    WITH retried_run AS (
      UPDATE goat.brain_import_runs
      SET status = 'discovering',
          discovery_summary = '{}'::jsonb,
          result = '{}'::jsonb,
          last_error = NULL,
          completed_at = NULL,
          next_run_at = now(),
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = ${input.importRunId}
        AND brain_ref = ${input.brainRef}
        AND status = 'failed'
        AND confirmed_at IS NULL
      RETURNING id
    ),
    deleted_candidates AS (
      DELETE FROM goat.brain_import_candidates AS candidate
      USING retried_run AS run
      WHERE candidate.import_run_id = run.id
      RETURNING candidate.id
    )
    SELECT
      run.id AS "importRunId",
      (SELECT count(*)::integer FROM deleted_candidates) AS "deletedCandidates"
    FROM retried_run AS run
  `);
  const row = rowsFromExecute<{ importRunId: string; deletedCandidates: number }>(result)[0];
  if (!row) throw new CoreError("conflict", "Only a failed source scan can be retried.");
  return row;
}

export async function getBrainImportJobProgress(
  importRunId: string,
  db: DbLike = getDb(),
): Promise<{
  rows: Array<{
    status: string;
    provider: string;
    sourceRef: string;
    result: Record<string, unknown>;
    lastError: string | null;
  }>;
  terminal: boolean;
}> {
  const rows = await db
    .select({
      status: brainIngestJobs.status,
      provider: brainIngestJobs.sourceProvider,
      sourceRef: brainSourceItems.sourceRef,
      result: brainIngestJobs.result,
      lastError: brainIngestJobs.lastError,
    })
    .from(brainIngestJobs)
    .innerJoin(brainSourceItems, eq(brainSourceItems.id, brainIngestJobs.sourceItemId))
    .where(eq(brainIngestJobs.importRunId, importRunId))
    .orderBy(brainIngestJobs.createdAt);
  return {
    rows,
    terminal: rows.every((row: { status: string }) =>
      IMPORT_TERMINAL_JOB_STATUSES.includes(
        row.status as (typeof IMPORT_TERMINAL_JOB_STATUSES)[number],
      ),
    ),
  };
}

function isUnsafeHostname(hostname: string) {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return true;
  }
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const version = isIP(unwrapped);
  if (version === 4) {
    const [a = 0, b = 0, c = 0] = unwrapped.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (version === 6) {
    const normalized = unwrapped.toLowerCase();
    const mappedIpv4 = ipv4FromMappedIpv6(normalized);
    if (mappedIpv4) return isUnsafeHostname(mappedIpv4);
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("2001:db8") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  return !hostname.includes(".");
}

function ipv4FromMappedIpv6(value: string) {
  if (!value.startsWith("::ffff:")) return null;
  const suffix = value.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(":");
  if (parts.length !== 2) return null;
  const high = Number.parseInt(parts[0] ?? "", 16);
  const low = Number.parseInt(parts[1] ?? "", 16);
  if (![high, low].every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)) {
    return null;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

export function rankStoredBrainImportCandidate(
  provider: Exclude<BrainImportProvider, "public_web">,
  value: unknown,
) {
  const item = asRecord(value);
  const content = asRecord(item.content);
  switch (provider) {
    case "github": {
      const activity = asRecord(content.activity);
      const actor = `${activity.author ?? ""} ${activity.mergedBy ?? ""}`.toLowerCase();
      const title = String(item.title ?? "").toLowerCase();
      if (actor.includes("[bot]") || actor.includes("dependabot") || title.includes("dependabot")) {
        return Number.NEGATIVE_INFINITY;
      }
      const state = activity.state;
      const priority = state === "merged" ? 300 : state === "commented" ? 200 : 100;
      return (
        priority +
        numeric(activity.comments) * 10 +
        numeric(activity.additions) +
        numeric(activity.deletions)
      );
    }
    case "jamie": {
      const meeting = asRecord(content.meeting);
      const substance =
        String(meeting.summaryMarkdown ?? "").length + arrayLength(meeting.transcript);
      return substance > 0 ? 100 + substance : Number.NEGATIVE_INFINITY;
    }
    case "granola": {
      const meeting = asRecord(content.meeting);
      const substance =
        String(meeting.summaryMarkdown ?? "").length + arrayLength(meeting.transcript);
      return substance > 0 ? 100 + substance : Number.NEGATIVE_INFINITY;
    }
    case "fathom": {
      const meeting = asRecord(content.meeting);
      const substance =
        String(meeting.summaryMarkdown ?? "").length + arrayLength(meeting.transcript);
      return substance > 0 ? 100 + substance : Number.NEGATIVE_INFINITY;
    }
    case "gmail": {
      const thread = asRecord(content.thread);
      const messages = asRecords(thread.messages);
      const directions = new Set(messages.map((message) => message.direction));
      const substantive = messages.filter(
        (message) => String(message.bodyText ?? "").trim().length >= 40,
      ).length;
      return (directions.size > 1 ? 300 : 100) + substantive * 20 + messages.length;
    }
    case "linear": {
      const issue = asRecord(content.issue);
      if (String(issue.stateType ?? "").toLowerCase() === "canceled")
        return Number.NEGATIVE_INFINITY;
      const comments = arrayLength(issue.comments);
      const description = String(issue.description ?? "").trim().length;
      const activity = asRecords(issue.activity);
      const substantive = activity.filter((entry) =>
        ["comment", "description", "priority", "scope"].some((term) =>
          String(entry.type ?? entry.action ?? "")
            .toLowerCase()
            .includes(term),
        ),
      ).length;
      if (comments === 0 && description === 0 && substantive === 0) return Number.NEGATIVE_INFINITY;
      return 100 + comments * 20 + substantive * 15 + Math.min(description, 1_000) / 100;
    }
  }
}

export function matchesBrainImportSelectedScope(
  provider: Exclude<BrainImportProvider, "public_web">,
  value: unknown,
  config: Record<string, unknown> | undefined,
) {
  const item = asRecord(value);
  const content = asRecord(item.content);
  switch (provider) {
    case "github": {
      const repository = asRecord(asRecord(content.activity).repository);
      const allowed = configuredIds(config?.repos, ["id", "fullName"]);
      return (
        allowed.has(String(repository.id ?? "")) || allowed.has(String(repository.fullName ?? ""))
      );
    }
    case "linear": {
      const teamId = String(asRecord(content.issue).teamId ?? "");
      return configuredIds(config?.teams, ["id"]).has(teamId);
    }
    case "gmail": {
      const configuredEvents = configuredIds(config?.events, ["id"]);
      const directions = new Set(
        asRecords(asRecord(content.thread).messages).map((message) => message.direction),
      );
      return (
        (configuredEvents.has("email_received") && directions.has("received")) ||
        (configuredEvents.has("email_sent") && directions.has("sent"))
      );
    }
    case "jamie":
    case "granola":
    case "fathom":
      return true;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecords(value: unknown) {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function configuredIds(value: unknown, keys: string[]) {
  const ids = new Set<string>();
  for (const entry of asRecords(value)) {
    for (const key of keys) {
      const id = entry[key];
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return ids;
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function numeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
