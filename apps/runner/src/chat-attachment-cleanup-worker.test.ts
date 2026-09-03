import { PGlite } from "@electric-sql/pglite";
import type { PooledDbClient, PooledDbHandle } from "@opencompany/db/pool";
import { BlobNotFoundError } from "@vercel/blob";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_ATTACHMENT_CLEANUP_GRACE_MS,
  CHAT_ATTACHMENT_COMMAND_RETENTION_MS,
  cleanExpiredChatAttachments,
  isBlobNotFound,
  startChatAttachmentCleanupWorker,
} from "./chat-attachment-cleanup-worker";

type Pool = PooledDbHandle["pool"];
const now = new Date("2026-08-12T00:15:00.000Z");
const expiredAt = new Date(now.getTime() - CHAT_ATTACHMENT_CLEANUP_GRACE_MS);

describe("chat attachment cleanup", () => {
  it("deletes ready, incomplete, and legacy uploads in candidate transactions", async () => {
    const candidates = [
      { kind: "command", id: "command_ready" },
      { kind: "command", id: "command_incomplete" },
      { kind: "legacy", id: "attachment_legacy" },
    ];
    const client = fakeClient(async (query, params) => {
      if (query.includes("pg_try_advisory_lock")) return rows([{ acquired: true }]);
      if (query.includes("WITH candidates AS")) return rows(candidates);
      if (query.includes("SELECT attachment_id")) {
        const id = params?.[0];
        return rows([
          {
            attachmentId: id === "command_ready" ? "attachment_ready" : "attachment_incomplete",
            blobPathname: `private/${String(id)}`,
            expiresAt: expiredAt,
            cleanedAt: null,
          },
        ]);
      }
      if (query.includes("SELECT id, blob_url")) {
        return params?.[0] === "attachment_ready"
          ? rows([
              {
                id: "attachment_ready",
                blobUrl: "https://blob.invalid/ready",
                claimedAt: null,
              },
            ])
          : rows([]);
      }
      if (query.includes('SELECT blob_url AS "blobUrl"')) {
        return rows([
          {
            blobUrl: "https://blob.invalid/legacy",
            claimedAt: null,
            expiresAt: expiredAt,
          },
        ]);
      }
      return rows([]);
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const deleteBlob = vi.fn(async (_target: string) => undefined);

    await expect(
      cleanExpiredChatAttachments({
        pool,
        token: "test-token",
        signal: new AbortController().signal,
        now,
        deleteBlob,
      }),
    ).resolves.toEqual({
      acquired: true,
      found: 3,
      cleaned: 3,
      purged: 0,
      failed: 0,
      skipped: 0,
    });
    expect(deleteBlob.mock.calls.map(([target]) => target)).toEqual([
      "https://blob.invalid/ready",
      "private/command_incomplete",
      "https://blob.invalid/legacy",
    ]);
    expect(client.query.mock.calls.filter(([query]) => query === "BEGIN")).toHaveLength(3);
    expect(client.query.mock.calls.filter(([query]) => query === "COMMIT")).toHaveLength(3);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("preserves metadata after storage failure and continues with the batch", async () => {
    const client = fakeClient(async (query, params) => {
      if (query.includes("pg_try_advisory_lock")) return rows([{ acquired: true }]);
      if (query.includes("WITH candidates AS")) {
        return rows([
          { kind: "command", id: "command_failed" },
          { kind: "legacy", id: "attachment_next" },
        ]);
      }
      if (query.includes("SELECT attachment_id")) {
        return rows([
          {
            attachmentId: "attachment_failed",
            blobPathname: "private/failed",
            expiresAt: expiredAt,
            cleanedAt: null,
          },
        ]);
      }
      if (query.includes("SELECT id, blob_url")) {
        return rows([
          {
            id: "attachment_failed",
            blobUrl: "https://blob.invalid/failed",
            claimedAt: null,
          },
        ]);
      }
      if (query.includes('SELECT blob_url AS "blobUrl"')) {
        expect(params?.[0]).toBe("attachment_next");
        return rows([
          {
            blobUrl: "https://blob.invalid/next",
            claimedAt: null,
            expiresAt: expiredAt,
          },
        ]);
      }
      return rows([]);
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const deleteBlob = vi.fn(async (target: string) => {
      if (target.endsWith("/failed")) throw new Error("storage unavailable");
    });

    await expect(
      cleanExpiredChatAttachments({
        pool,
        token: "test-token",
        signal: new AbortController().signal,
        now,
        deleteBlob,
      }),
    ).resolves.toEqual({
      acquired: true,
      found: 2,
      cleaned: 1,
      purged: 0,
      failed: 1,
      skipped: 0,
    });
    expect(client.query.mock.calls.filter(([query]) => query === "ROLLBACK")).toHaveLength(1);
    const failedDeletes = client.query.mock.calls.filter(
      ([query, params]) => query.startsWith("DELETE") && params?.[0] === "attachment_failed",
    );
    expect(failedDeletes).toHaveLength(0);
  });

  it("rechecks claimed and grace-period uploads before deleting", async () => {
    const client = fakeClient(async (query) => {
      if (query.includes("pg_try_advisory_lock")) return rows([{ acquired: true }]);
      if (query.includes("WITH candidates AS")) {
        return rows([
          { kind: "command", id: "command_claimed" },
          { kind: "legacy", id: "attachment_fresh" },
        ]);
      }
      if (query.includes("SELECT attachment_id")) {
        return rows([
          {
            attachmentId: "attachment_claimed",
            blobPathname: "private/claimed",
            expiresAt: expiredAt,
            cleanedAt: null,
          },
        ]);
      }
      if (query.includes("SELECT id, blob_url")) {
        return rows([
          {
            id: "attachment_claimed",
            blobUrl: "https://blob.invalid/claimed",
            claimedAt: now,
          },
        ]);
      }
      if (query.includes('SELECT blob_url AS "blobUrl"')) {
        return rows([
          {
            blobUrl: "https://blob.invalid/fresh",
            claimedAt: null,
            expiresAt: new Date(expiredAt.getTime() + 1),
          },
        ]);
      }
      return rows([]);
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const deleteBlob = vi.fn();

    await expect(
      cleanExpiredChatAttachments({
        pool,
        token: "test-token",
        signal: new AbortController().signal,
        now,
        deleteBlob,
      }),
    ).resolves.toEqual({
      acquired: true,
      found: 2,
      cleaned: 0,
      purged: 0,
      failed: 0,
      skipped: 2,
    });
    expect(deleteBlob).not.toHaveBeenCalled();
  });

  it("reaches an eligible upload past a large prefix of expired claimed commands", async () => {
    const database = await PGlite.create();
    try {
      await database.exec(`
        CREATE SCHEMA goat;
        CREATE TABLE goat.chat_attachment_upload_commands (
          command_id text PRIMARY KEY,
          attachment_id text NOT NULL UNIQUE,
          blob_pathname text NOT NULL UNIQUE,
          expires_at timestamptz NOT NULL,
          claimed_at timestamptz,
          cleaned_at timestamptz,
          touched_at timestamptz NOT NULL
        );
        CREATE INDEX command_cleanup_idx
          ON goat.chat_attachment_upload_commands (expires_at, command_id)
          WHERE cleaned_at IS NULL AND claimed_at IS NULL;
        CREATE INDEX command_terminal_idx
          ON goat.chat_attachment_upload_commands (cleaned_at, command_id)
          WHERE cleaned_at IS NOT NULL;
        CREATE TABLE goat.chat_attachment_uploads (
          id text PRIMARY KEY,
          blob_url text NOT NULL,
          expires_at timestamptz NOT NULL,
          claimed_at timestamptz
        );
      `);
      const terminalAt = new Date(now.getTime() - CHAT_ATTACHMENT_COMMAND_RETENTION_MS - 1);
      await database.query(
        `
          INSERT INTO goat.chat_attachment_upload_commands (
            command_id, attachment_id, blob_pathname, expires_at,
            claimed_at, cleaned_at, touched_at
          )
          SELECT
            'claimed_command_' || value,
            'claimed_attachment_' || value,
            'private/claimed/' || value,
            $1,
            $2,
            $2,
            $2
          FROM generate_series(1, 250) AS value
        `,
        [expiredAt, terminalAt],
      );
      await database.query(
        `
          INSERT INTO goat.chat_attachment_uploads (id, blob_url, expires_at, claimed_at)
          SELECT
            'claimed_attachment_' || value,
            'https://blob.invalid/claimed/' || value,
            $1,
            $2
          FROM generate_series(1, 250) AS value
        `,
        [expiredAt, terminalAt],
      );
      await database.query(
        `
          INSERT INTO goat.chat_attachment_upload_commands (
            command_id, attachment_id, blob_pathname, expires_at, touched_at
          ) VALUES ('eligible_command', 'eligible_attachment', 'private/eligible', $1, $1)
        `,
        [expiredAt],
      );
      await database.query(
        `
          INSERT INTO goat.chat_attachment_uploads (id, blob_url, expires_at)
          VALUES ('eligible_attachment', 'https://blob.invalid/eligible', $1)
        `,
        [expiredAt],
      );
      const client = {
        query: vi.fn(async (query: string, params?: unknown[]) => {
          if (query.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (query.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
          return database.query(query, params as never[] | undefined);
        }),
        release: vi.fn(),
      } as unknown as PooledDbClient;
      const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
      const deleteBlob = vi.fn(async () => undefined);

      await expect(
        cleanExpiredChatAttachments({
          pool,
          token: "test-token",
          signal: new AbortController().signal,
          now,
          batchSize: 100,
          deleteBlob,
        }),
      ).resolves.toEqual({
        acquired: true,
        found: 1,
        cleaned: 1,
        purged: 100,
        failed: 0,
        skipped: 0,
      });
      expect(deleteBlob).toHaveBeenCalledOnce();
      expect(deleteBlob).toHaveBeenCalledWith(
        "https://blob.invalid/eligible",
        expect.objectContaining({ token: "test-token" }),
      );
      await expect(
        database.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM goat.chat_attachment_upload_commands",
        ),
      ).resolves.toMatchObject({ rows: [{ count: 151 }] });
    } finally {
      await database.close();
    }
  }, 15_000);

  it("does no work when another runner owns the advisory lock", async () => {
    const client = fakeClient(async (query) => {
      if (query.includes("pg_try_advisory_lock")) return rows([{ acquired: false }]);
      throw new Error(`Unexpected query: ${query}`);
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(
      cleanExpiredChatAttachments({
        pool,
        token: "test-token",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      acquired: false,
      found: 0,
      cleaned: 0,
      purged: 0,
      failed: 0,
      skipped: 0,
    });
    expect(client.query).toHaveBeenCalledOnce();
  });

  it("fails startup explicitly without Blob credentials", () => {
    expect(() =>
      startChatAttachmentCleanupWorker({ blobReadWriteToken: undefined }, { pool: {} as Pool }),
    ).toThrow(/BLOB_READ_WRITE_TOKEN/u);
  });

  it("repolls immediately after a full batch", async () => {
    let listCalls = 0;
    const client = fakeClient(async (query, params) => {
      if (query.includes("pg_try_advisory_lock")) return rows([{ acquired: true }]);
      if (query.includes("WITH candidates AS")) {
        listCalls += 1;
        return listCalls === 1
          ? rows([
              { kind: "legacy", id: "legacy_1" },
              { kind: "legacy", id: "legacy_2" },
            ])
          : rows([]);
      }
      if (query.includes('SELECT blob_url AS "blobUrl"')) {
        return rows([
          {
            blobUrl: `https://blob.invalid/${String(params?.[0])}`,
            claimedAt: null,
            expiresAt: expiredAt,
          },
        ]);
      }
      return rows([]);
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const worker = startChatAttachmentCleanupWorker(
      { blobReadWriteToken: "test-token" },
      { pool, batchSize: 2, pollIntervalMs: 60_000, deleteBlob: vi.fn(async () => undefined) },
    );

    await vi.waitFor(() => expect(listCalls).toBe(2));
    await worker.stop();
  });

  it("passes the shutdown deadline abort to in-flight Blob deletion", async () => {
    const client = fakeClient(async (query) => {
      if (query.includes("pg_try_advisory_lock")) return rows([{ acquired: true }]);
      if (query.includes("WITH candidates AS")) {
        return rows([{ kind: "command", id: "command_inflight" }]);
      }
      if (query.includes("SELECT attachment_id")) {
        return rows([
          {
            attachmentId: "attachment_inflight",
            blobPathname: "private/inflight",
            expiresAt: expiredAt,
            cleanedAt: null,
          },
        ]);
      }
      if (query.includes("SELECT id, blob_url")) return rows([]);
      return rows([]);
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    let workSignal: AbortSignal | undefined;
    const deleteBlob = vi.fn(
      (_target: string, options: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          workSignal = options.signal;
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const worker = startChatAttachmentCleanupWorker(
      { blobReadWriteToken: "test-token" },
      { pool, pollIntervalMs: 60_000, deleteBlob },
    );
    await vi.waitFor(() => expect(workSignal).toBeDefined());
    const deadline = new AbortController();

    const stopped = worker.stop({ signal: deadline.signal });
    expect(workSignal?.aborted).toBe(false);
    deadline.abort(new Error("shutdown deadline"));
    await stopped;
    expect(workSignal?.aborted).toBe(true);
  });

  it("recognizes a missing Blob object as already cleaned", () => {
    expect(isBlobNotFound(new BlobNotFoundError())).toBe(true);
    expect(isBlobNotFound(new Error("not found"))).toBe(false);
  });
});

function fakeClient(execute: (query: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  return {
    query: vi.fn(execute),
    release: vi.fn(),
  } as unknown as PooledDbClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

function rows<Row>(values: Row[]) {
  return Promise.resolve({ rows: values });
}
