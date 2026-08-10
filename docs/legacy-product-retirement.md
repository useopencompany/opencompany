# Legacy product retirement

GitHub issue #1156 retired the first product generation in three independently deployable phases.
PR #1157 relocated the Stripe webhook and compatibility behavior. PR #1161 removed the generic
session/runtime engine. The final phase deletes the remaining application, Inngest shim, messaging,
memory, managed-repository sync, Durable Streams, PR-preview deployment, and legacy release/setup
paths.

No phase adds a schema-drop migration. Existing migration history and compatibility data remain.

## Deleted and retained responsibilities

| Deleted | Retained owner |
| --- | --- |
| first-generation Next.js product and workspace repository sync | `apps/goat` product and direct GitHub integrations |
| generic sessions, `.agent` files, tools, and runtime configuration | Goat durable sessions/turns and current runtime contracts |
| Inngest app/functions and local shim | runner workers and schedules |
| WhatsApp/messaging and file-backed memory packages | Goat integrations and `packages/goat-brain` |
| Durable Streams transcript transport | Goat Postgres persistence plus Electric live shapes |
| legacy PR environment provisioning/reaping | branch-isolated Neon local setup and runner coding-workspace previews |
| legacy web Vercel build/deploy/smoke | Goat and marketing Vercel releases, Render runner, release-aware health checks |
| broad public-schema model/export surface | Goat schema plus isolated legacy-billing and LLM-broker schemas |

The Stripe webhook, billing compatibility behavior/schema, LLM broker, Goat runner, Stripe local
forwarder, branch-isolated Neon setup, migration history, and release health checks are deliberately
retained.

## Production Stripe cutover

The production cutover completed on 2026-08-10 before the final deletion:

- created endpoint `we_1U2wUhLXotdOfI7sf56W2RHu` at
  `https://my.opencompany.chat/api/stripe/webhook` with the ten required Checkout, subscription,
  invoice, and PaymentIntent events;
- rotated the signing secret after terminal output exposed the prior value, updated Infisical
  `prod` `/goat` and the rollback `/web` copy, and verified host sync;
- verified the restricted Goat Stripe key can read SetupIntents/PaymentMethods and update Customers;
- completed production release run `31411536697`, including migrations, Goat, runner, marketing,
  health checks, and the then-still-present rollback deployment;
- sent a signed probe and replayed live event `evt_1U1gxeLXotdOfI7sHJzgTCcB`; Goat returned `2xx` and
  persisted one processed webhook-event row;
- disabled the previous endpoint after the Goat delivery passed.

After this phase merges, the billing owner should perform one final dashboard check: the replacement
endpoint remains enabled, its latest deliveries are `2xx`, the old endpoint remains disabled, and a
test-mode credit top-up produces one credit grant. This is the only required manual external smoke;
it cannot be made part of CI because it depends on Stripe dashboard/test-customer state.

Before the final phase, rollback was to point the replacement endpoint back to the rollback app.
After the code is deleted, rollback requires reverting this PR and redeploying that commit before
changing Stripe. Database rollback is unnecessary because no migration is introduced.

## Intentional historical references

The following locations may name retired tables, routes, or product concepts and are not active
runtime or operational configuration:

- immutable SQL and journal entries under `drizzle/`;
- `CHANGELOG.md` entries describing shipped behavior;
- research snapshots under `apps/goat/research` and `docs/future-concepts`;
- the migration-only public schema in `packages/db/src/schema.ts` and compatibility exports in
  `legacy-billing-schema.ts`, `llm-broker-schema.ts`, and Goat billing modules. The public schema is
  deliberately not a package export or runtime database schema; retaining it prevents future
  Drizzle generation from interpreting preserved tables as drops.

All other searches for the deleted application/package names and runtime entry points should be
empty.
