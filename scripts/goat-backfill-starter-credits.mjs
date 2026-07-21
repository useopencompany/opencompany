#!/usr/bin/env node

// Idempotent starter-grant backfill for Goat billing v4: every workspace gets
// the one-time $5 starter credit before GOAT_CREDITS_ENFORCEMENT_ENABLED flips
// on, so no existing workspace is hard-stopped mid-session. Safe to re-run —
// the partial unique index on (workspace_id) WHERE source = 'starter_grant'
// turns replays into no-ops. Mirrors grantGoatStarterCredit in
// packages/db/src/goat-credits.ts.
//
// Usage: DATABASE_URL=postgres://... node scripts/goat-backfill-starter-credits.mjs

import { exit } from "node:process";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set DATABASE_URL to the target database before running the backfill.");
  exit(1);
}

const STARTER_CREDIT_USD_CENTS = 500;
const USD_MICROS_PER_CENT = 10_000;

const sql = neon(databaseUrl);

const workspaces = await sql`SELECT id FROM goat.workspaces ORDER BY created_at ASC`;
let granted = 0;
let skipped = 0;
for (const workspace of workspaces) {
  const rows = await sql`
    WITH ledger AS (
      INSERT INTO goat.credit_ledger (
        workspace_id,
        amount_cents,
        amount_usd_micros,
        source,
        metadata
      )
      VALUES (
        ${workspace.id},
        ${STARTER_CREDIT_USD_CENTS},
        ${STARTER_CREDIT_USD_CENTS}::bigint * ${USD_MICROS_PER_CENT},
        'starter_grant',
        jsonb_build_object('reason', 'goat_billing_v4_backfill')
      )
      ON CONFLICT (workspace_id) WHERE source = 'starter_grant' DO NOTHING
      RETURNING workspace_id, amount_cents, amount_usd_micros
    ),
    balance AS (
      INSERT INTO goat.credit_balances (workspace_id, balance_cents, balance_usd_micros, updated_at)
      SELECT workspace_id, amount_cents, amount_usd_micros, now()
      FROM ledger
      ON CONFLICT (workspace_id) DO UPDATE
      SET balance_cents = goat.credit_balances.balance_cents + excluded.balance_cents,
          balance_usd_micros = goat.credit_balances.balance_usd_micros + excluded.balance_usd_micros,
          updated_at = now()
      RETURNING workspace_id
    )
    SELECT workspace_id FROM balance
  `;
  if (rows.length > 0) granted += 1;
  else skipped += 1;
}

console.log(
  `Starter-credit backfill complete: ${granted} granted, ${skipped} already had a grant (of ${workspaces.length} workspaces).`,
);
