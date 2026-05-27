# Billing money invariants

## Context

Billing currently stores both cents and USD micros in balance and ledger tables, and several money fields are Postgres `bigint` mapped to JavaScript `number`.

Relevant code:

- `packages/db/src/schema.ts`
- `packages/billing/src/index.ts`
- `apps/web/lib/billing/service.ts`
- `apps/web/lib/billing/actions.ts`
- `apps/web/app/api/stripe/webhook/route.ts`

## Problem

Dual canonical units invite drift, and JS `number` for bigint money fields is not the right long-term boundary. Even if current values are small, billing code should be boring and exact before real volume grows.

## Goal

Make USD micros the single canonical unit for internal billing and keep integer precision safe end to end.

## Suggested approach

- Keep `amount_usd_micros`, `provider_cost_usd_micros`, `platform_fee_usd_micros`, and `balance_usd_micros` as canonical.
- Use `bigint` mode for Drizzle money fields, or define an explicit safe conversion layer if UI code needs `number`.
- Treat cents as presentation/Stripe input only, or maintain it as a derived compatibility field with clear constraints.
- Add database checks for non-negative credit additions where applicable and consistent sign conventions in ledger rows.
- Centralize money conversion helpers in `packages/billing`.

## Acceptance criteria

- There is one clearly documented canonical internal money unit.
- Ledger and balance updates cannot drift between cents and micros.
- Bigint values are not silently truncated through JS `number` at persistence boundaries.
- Existing billing UI and Stripe webhook paths still work.
- Tests cover signup credit, Stripe fulfillment idempotency, model usage debit, tool usage debit, and balance display conversions.

## Verification

Run:

```sh
bun --filter @opencompany/billing test
bun --filter @opencompany/web test -- lib/billing
bun run typecheck
```
