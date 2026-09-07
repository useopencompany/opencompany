import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimNextGoogleDriveFile } from "./google-drive";

const RAW_TIMESTAMP_FAILURE =
  "observedAt.getTime is not a function. (In 'observedAt.getTime()', 'observedAt.getTime' is undefined)";

describe("Google Drive file claims", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.google_drive_file_states (
        id text PRIMARY KEY,
        integration_id text NOT NULL,
        user_workos_id text NOT NULL,
        file_id text NOT NULL,
        drive_id text,
        observed_version text NOT NULL,
        ingested_version text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        first_observed_at timestamptz NOT NULL,
        last_observed_at timestamptz NOT NULL,
        next_ingest_at timestamptz NOT NULL,
        force_ingest_at timestamptz NOT NULL,
        lease_id text,
        lease_owner text,
        lease_expires_at timestamptz,
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
    `);
  });

  afterEach(async () => {
    await database.close();
  });

  it("decodes raw timestamps and gives exhausted timestamp failures one bounded recovery claim", async () => {
    await database.query(
      `INSERT INTO goat.google_drive_file_states (
        id, integration_id, user_workos_id, file_id, observed_version, ingested_version,
        first_observed_at, last_observed_at, next_ingest_at, force_ingest_at,
        attempts, last_error, created_at, updated_at
      ) VALUES
        (
          'fresh', 'integration', 'user', 'fresh-file', '2', '1',
          '2026-09-06T16:30:00Z', '2026-09-06T16:45:00Z',
          '2026-09-06T16:55:00Z', '2026-09-06T17:15:00Z',
          1, NULL, '2026-09-06T16:30:00Z', '2026-09-06T16:45:00Z'
        ),
        (
          'recoverable', 'integration', 'user', 'recoverable-file', '2', '1',
          '2026-09-06T15:00:00Z', '2026-09-06T16:00:00Z',
          '2026-09-06T16:05:00Z', '2026-09-06T16:10:00Z',
          5, $1, '2026-09-06T15:00:00Z', '2026-09-06T16:00:00Z'
        ),
        (
          'unrelated', 'integration', 'user', 'unrelated-file', '2', '1',
          '2026-09-06T15:00:00Z', '2026-09-06T16:00:00Z',
          '2026-09-06T16:05:00Z', '2026-09-06T16:10:00Z',
          5, 'unrelated failure', '2026-09-06T15:00:00Z', '2026-09-06T16:00:00Z'
        )`,
      [RAW_TIMESTAMP_FAILURE],
    );

    const db = drizzle(database);
    const fresh = await claimNextGoogleDriveFile({
      leaseId: "fresh-lease",
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-09-06T17:30:00Z"),
      now: new Date("2026-09-06T17:00:00Z"),
      db,
    });

    expect(fresh?.id).toBe("fresh");
    expect(fresh?.attempts).toBe(2);
    expect(fresh?.firstObservedAt).toEqual(new Date("2026-09-06T16:30:00Z"));
    expect(fresh?.lastObservedAt).toEqual(new Date("2026-09-06T16:45:00Z"));

    const recovery = await claimNextGoogleDriveFile({
      leaseId: "recovery-lease",
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-09-06T17:30:00Z"),
      now: new Date("2026-09-06T17:00:00Z"),
      db,
    });

    expect(recovery?.id).toBe("recoverable");
    expect(recovery?.attempts).toBe(6);
    expect(recovery?.firstObservedAt).toEqual(new Date("2026-09-06T15:00:00Z"));
    expect(recovery?.lastObservedAt).toEqual(new Date("2026-09-06T16:00:00Z"));

    expect(
      await claimNextGoogleDriveFile({
        leaseId: "next-lease",
        leaseOwner: "worker",
        leaseExpiresAt: new Date("2026-09-06T17:30:00Z"),
        now: new Date("2026-09-06T17:00:00Z"),
        db,
      }),
    ).toBeNull();
  });
});
