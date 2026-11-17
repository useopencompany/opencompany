# Electric read models

Electric is an authorized read optimization, not a product API or execution dependency. Postgres
source rows remain authoritative. The web app uses Electric only through API-owned authorized read
models; browsers never receive database credentials or talk directly to Electric.

The browser selects a fixed public name under `/v1/read-models/{readModel}`. The API chooses the
physical projection table, columns, Actor/workspace predicate, and allowed parameters for that
name. There is no generic web shape route and the browser cannot select a table, column, or SQL
predicate.

Current product collections live in domain-specific modules under `apps/web/lib`, including the
Chat collections in `headless-chat-collections.ts`. Named read models cover Conversations,
Messages, Runs, Tasks, Workflows, schedules, Wiki, Skills,
integrations, and related projections. Commands still go through typed `/v1` resources; the runner
persists durable state before Electric delivers a committed projection.

Job read models expose only bounded activity and normalized result fields. Worker leases,
provider payloads, credential locators, physical Actor fields, and raw result data do not enter the
read model.

Local setup starts a self-hosted Electric container when Docker or OrbStack is available and writes
`ELECTRIC_URL` for the local API stack. Run `bun run electric:dev` to keep Electric in the
foreground. Hosted API uses either `ELECTRIC_URL` plus `ELECTRIC_TOKEN`, or Electric Cloud source
credentials. Electric must connect to the direct Neon endpoint with logical replication enabled.

## Production self-hosting

Production Electric is a Kamal accessory of the API, `opencompany-api-electric`, on the private
`kamal` Docker network of the Hetzner server. It runs the image digest pinned in
`apps/api/config/deploy.yml`, keeps its shape log in the named volume `opencompany-electric-data` at
`/var/electric`, and replicates through the `opencompany_hetzner_v1` stream. Infisical prod
`/electric` owns `DATABASE_URL` and `ELECTRIC_SECRET`. The API reaches it through
`ELECTRIC_URL=http://opencompany-api-electric:3000` in the API's Kamal config and shares the same
`ELECTRIC_SECRET`. Prod `/api` also holds `ELECTRIC_AUTH_MODE=self-hosted` and
`BUN_CONFIG_MAX_HTTP_REQUESTS=4096` for the Bun read-model proxy.
[Hosting](hosting.md#electric) covers restarts and rebuilds.

The suspended Render Electric (`opencompany-electric`, stream `opencompany_render_v1`) and the
stale Render `ELECTRIC_URL` in `/api` remain only as the way back until the Render services are
deleted. Its publication and slot are dropped in that cleanup.

The disk state and Postgres replication resources are one consistency unit. Do not change
`ELECTRIC_STORAGE_DIR`, `ELECTRIC_REPLICATION_STREAM_ID`, or `DATABASE_URL`, clear the disk, or drop
the corresponding publication/slot independently. A deliberate rebuild must start with a fresh
stream ID and empty disk, then warm and validate shapes before traffic moves.

### Electric Cloud cutover

1. Provision the self-hosted service with a unique replication stream while Electric Cloud remains
   connected. Confirm `/v1/health` reports `active` and the new slot is active with bounded lag.
2. Warm every named read model through the API proxy and verify Chat, Tasks, Workflows, Wiki,
   Skills, schedules, and integrations. Postgres is authoritative; no Electric data is copied.
3. Set prod `/api` `ELECTRIC_URL` to the Render private origin and switch `ELECTRIC_AUTH_MODE` to
   `self-hosted`. Keep both the self-hosted secret and Cloud source credentials during the
   observation window so rollback is a URL and auth-mode change, not secret recovery.
4. Redeploy the API and verify a new Chat message streams live, survives reload, and appears in the
   conversation list. Monitor API 502/503 responses, Electric logs/resources, disk usage, and
   replication lag.
5. Remove the old Cloud publication/slot and credentials only in a separately approved cleanup.

One volume permits one Electric instance, and `kamal accessory reboot electric` causes a brief
interruption. Clients must be allowed to retry/refetch; do not add an application fallback that bypasses
the authorized read-model proxy.
