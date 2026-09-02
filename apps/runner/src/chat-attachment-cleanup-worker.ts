import type { PooledDbClient, PooledDbHandle } from "@opencompany/db/pool";
import { createLogger } from "@opencompany/observability";
import { BlobNotFoundError, del } from "@vercel/blob";
import type { RunnerEnv } from "./env";
import { createPollingWorker } from "./polling-worker";

type Pool = PooledDbHandle["pool"];

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "chat-attachment-cleanup-worker",
});

const CLEANUP_LOCK_NAME = "opencompany.chat-attachment-cleanup.v1";
const CLEANUP_INTERVAL_MS = 60 * 60_000;
export const CHAT_ATTACHMENT_CLEANUP_GRACE_MS = 15 * 60_000;
export const CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE = 100;

type CleanupCandidate = {
  kind: "command" | "legacy";
  id: string;
};

export type ChatAttachmentCleanupResult = {
  acquired: boolean;
  found: number;
  cleaned: number;
  failed: number;
  skipped: number;
};

export async function cleanExpiredChatAttachments(input: {
  pool: Pool;
  token: string;
  signal: AbortSignal;
  now?: Date;
  batchSize?: number;
  deleteBlob?: (target: string, options: { token: string; signal: AbortSignal }) => Promise<void>;
  onCandidateFailure?: (candidate: CleanupCandidate, error: unknown) => void;
}): Promise<ChatAttachmentCleanupResult> {
  const now = input.now ?? new Date();
  const batchSize = positiveInteger(
    input.batchSize ?? CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE,
    "batchSize",
  );
  const deleteBlob = input.deleteBlob ?? deletePrivateBlob;
  const client = await input.pool.connect();
  let acquired = false;
  let fatalError: unknown;

  try {
    input.signal.throwIfAborted();
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [CLEANUP_LOCK_NAME],
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) return emptyResult(false);

    const candidates = await listCandidates(client, now, batchSize);
    let cleaned = 0;
    let failed = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      input.signal.throwIfAborted();
      try {
        const removed = await cleanCandidate({
          client,
          candidate,
          now,
          token: input.token,
          signal: input.signal,
          deleteBlob,
        });
        if (removed) cleaned += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        input.onCandidateFailure?.(candidate, error);
      }
    }
    return { acquired: true, found: candidates.length, cleaned, failed, skipped };
  } catch (error) {
    fatalError = error;
    throw error;
  } finally {
    if (acquired && !fatalError) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
          CLEANUP_LOCK_NAME,
        ]);
      } catch (error) {
        client.release(true);
        throw error;
      }
    }
    if (fatalError) client.release(true);
    else client.release();
  }
}

export function startChatAttachmentCleanupWorker(
  env: Pick<RunnerEnv, "blobReadWriteToken">,
  options: {
    pool: Pool;
    pollIntervalMs?: number;
    batchSize?: number;
    deleteBlob?: (target: string, options: { token: string; signal: AbortSignal }) => Promise<void>;
  },
) {
  const token = requireChatAttachmentCleanupToken(env);
  return createPollingWorker({
    pollIntervalMs: Math.max(1_000, options.pollIntervalMs ?? CLEANUP_INTERVAL_MS),
    poll: async ({ signal }) => {
      const result = await cleanExpiredChatAttachments({
        pool: options.pool,
        token,
        signal,
        ...(options.batchSize ? { batchSize: options.batchSize } : {}),
        ...(options.deleteBlob ? { deleteBlob: options.deleteBlob } : {}),
        onCandidateFailure: (candidate, error) => {
          logger.error("Expired chat attachment cleanup candidate failed", {
            event: "opencompany.chat_attachment_cleanup_candidate_failed",
            candidate_kind: candidate.kind,
            candidate_id: candidate.id,
            error_name: error instanceof Error ? error.name : typeof error,
          });
        },
      });
      if (result.acquired) {
        logger.info("Expired chat attachment cleanup pass completed", {
          event: "opencompany.chat_attachment_cleanup_completed",
          found_count: result.found,
          cleaned_count: result.cleaned,
          failed_count: result.failed,
          skipped_count: result.skipped,
        });
      }
      return (
        result.acquired &&
        result.found === (options.batchSize ?? CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE)
      );
    },
    onError: (error) => {
      logger.error("Expired chat attachment cleanup pass failed", {
        event: "opencompany.chat_attachment_cleanup_failed",
        error_name: error instanceof Error ? error.name : typeof error,
      });
    },
  });
}

export function requireChatAttachmentCleanupToken(env: Pick<RunnerEnv, "blobReadWriteToken">) {
  const token = env.blobReadWriteToken?.trim();
  if (token) return token;
  throw new Error(
    "BLOB_READ_WRITE_TOKEN is required when the opencompany task-worker group is enabled; attachment cleanup cannot start.",
  );
}

async function listCandidates(client: PooledDbClient, now: Date, batchSize: number) {
  const result = await client.query<CleanupCandidate>(
    `
      WITH candidates AS (
        SELECT 'command'::text AS kind, command.command_id AS id, command.expires_at
        FROM goat.chat_attachment_upload_commands AS command
        LEFT JOIN goat.chat_attachment_uploads AS upload ON upload.id = command.attachment_id
        WHERE command.cleaned_at IS NULL
          AND command.expires_at + interval '15 minutes' <= $1
          AND upload.claimed_at IS NULL
        UNION ALL
        SELECT 'legacy'::text AS kind, upload.id, upload.expires_at
        FROM goat.chat_attachment_uploads AS upload
        WHERE upload.claimed_at IS NULL
          AND upload.expires_at + interval '15 minutes' <= $1
          AND NOT EXISTS (
            SELECT 1
            FROM goat.chat_attachment_upload_commands AS command
            WHERE command.attachment_id = upload.id
          )
      )
      SELECT kind, id
      FROM candidates
      ORDER BY expires_at, id
      LIMIT $2
    `,
    [now, batchSize],
  );
  return result.rows;
}

async function cleanCandidate(input: {
  client: PooledDbClient;
  candidate: CleanupCandidate;
  now: Date;
  token: string;
  signal: AbortSignal;
  deleteBlob: (target: string, options: { token: string; signal: AbortSignal }) => Promise<void>;
}) {
  await input.client.query("BEGIN");
  try {
    const cleaned =
      input.candidate.kind === "command"
        ? await cleanCommandCandidate(input)
        : await cleanLegacyCandidate(input);
    await input.client.query("COMMIT");
    return cleaned;
  } catch (error) {
    await input.client.query("ROLLBACK");
    throw error;
  }
}

async function cleanCommandCandidate(input: {
  client: PooledDbClient;
  candidate: CleanupCandidate;
  now: Date;
  token: string;
  signal: AbortSignal;
  deleteBlob: (target: string, options: { token: string; signal: AbortSignal }) => Promise<void>;
}) {
  const command = await input.client.query<{
    attachmentId: string;
    blobPathname: string;
    expiresAt: Date;
    cleanedAt: Date | null;
  }>(
    `
      SELECT attachment_id AS "attachmentId", blob_pathname AS "blobPathname",
             expires_at AS "expiresAt", cleaned_at AS "cleanedAt"
      FROM goat.chat_attachment_upload_commands
      WHERE command_id = $1
      FOR UPDATE
    `,
    [input.candidate.id],
  );
  const row = command.rows[0];
  if (
    !row ||
    row.cleanedAt ||
    row.expiresAt.getTime() + CHAT_ATTACHMENT_CLEANUP_GRACE_MS > input.now.getTime()
  ) {
    return false;
  }
  const upload = await input.client.query<{
    id: string;
    blobUrl: string;
    claimedAt: Date | null;
  }>(
    `
      SELECT id, blob_url AS "blobUrl", claimed_at AS "claimedAt"
      FROM goat.chat_attachment_uploads
      WHERE id = $1
      FOR UPDATE
    `,
    [row.attachmentId],
  );
  const uploadRow = upload.rows[0];
  if (uploadRow?.claimedAt) return false;

  await input.deleteBlob(uploadRow?.blobUrl ?? row.blobPathname, {
    token: input.token,
    signal: input.signal,
  });
  if (uploadRow) {
    await input.client.query(
      "DELETE FROM goat.chat_attachment_uploads WHERE id = $1 AND claimed_at IS NULL",
      [uploadRow.id],
    );
  }
  await input.client.query(
    `
      UPDATE goat.chat_attachment_upload_commands
      SET cleaned_at = $2, touched_at = $2
      WHERE command_id = $1 AND cleaned_at IS NULL
    `,
    [input.candidate.id, input.now],
  );
  return true;
}

async function cleanLegacyCandidate(input: {
  client: PooledDbClient;
  candidate: CleanupCandidate;
  now: Date;
  token: string;
  signal: AbortSignal;
  deleteBlob: (target: string, options: { token: string; signal: AbortSignal }) => Promise<void>;
}) {
  const upload = await input.client.query<{
    blobUrl: string;
    claimedAt: Date | null;
    expiresAt: Date;
  }>(
    `
      SELECT blob_url AS "blobUrl", claimed_at AS "claimedAt", expires_at AS "expiresAt"
      FROM goat.chat_attachment_uploads
      WHERE id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM goat.chat_attachment_upload_commands AS command
          WHERE command.attachment_id = chat_attachment_uploads.id
        )
      FOR UPDATE
    `,
    [input.candidate.id],
  );
  const row = upload.rows[0];
  if (
    !row ||
    row.claimedAt ||
    row.expiresAt.getTime() + CHAT_ATTACHMENT_CLEANUP_GRACE_MS > input.now.getTime()
  ) {
    return false;
  }
  await input.deleteBlob(row.blobUrl, { token: input.token, signal: input.signal });
  await input.client.query(
    "DELETE FROM goat.chat_attachment_uploads WHERE id = $1 AND claimed_at IS NULL",
    [input.candidate.id],
  );
  return true;
}

async function deletePrivateBlob(target: string, options: { token: string; signal: AbortSignal }) {
  try {
    await del(target, { token: options.token, abortSignal: options.signal });
  } catch (error) {
    if (isBlobNotFound(error)) return;
    throw error;
  }
}

export function isBlobNotFound(error: unknown) {
  return error instanceof BlobNotFoundError;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

function emptyResult(acquired: boolean): ChatAttachmentCleanupResult {
  return { acquired, found: 0, cleaned: 0, failed: 0, skipped: 0 };
}
