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
Messages, Runs, Tasks, Workflows, schedules, Brain documents and activity, Wiki, Skills,
integrations, and related projections. Commands still go through typed `/v1` resources; the runner
persists durable state before Electric delivers a committed projection.

`brain-ingest-jobs-v1` exposes only bounded activity and normalized result fields. Source metadata
is read separately through the authorized, bounded Brain source-item resource. Worker leases,
provider payloads, credential locators, physical Actor fields, and raw result data do not enter the
read model.

Local setup starts a self-hosted Electric container when Docker or OrbStack is available and writes
`ELECTRIC_URL` for the local API stack. Run `bun run electric:dev` to keep Electric in the
foreground. Hosted API uses either `ELECTRIC_URL` plus `ELECTRIC_TOKEN`, or Electric Cloud source
credentials. Electric must connect to the direct Neon endpoint with logical replication enabled.

## Production self-hosting

Production Electric runs as the private `opencompany-electric` Render service in Frankfurt. The
Render Blueprint pins the Electric image by digest, attaches a 20 GB persistent disk at
`/var/electric`, and uses the `opencompany_render_v1` replication stream. Infisical prod
`/electric` owns `DATABASE_URL` and `ELECTRIC_SECRET`; prod `/api` owns the private `ELECTRIC_URL`,
the same `ELECTRIC_SECRET`, `ELECTRIC_AUTH_MODE=self-hosted`, and
`BUN_CONFIG_MAX_HTTP_REQUESTS=4096` for the Bun read-model proxy.

The disk state and Postgres replication resources are one consistency unit. Do not change
`ELECTRIC_STORAGE_DIR`, `ELECTRIC_REPLICATION_STREAM_ID`, or `DATABASE_URL`, clear the disk, or drop
the corresponding publication/slot independently. A deliberate rebuild must start with a fresh
stream ID and empty disk, then warm and validate shapes before traffic moves.

### Electric Cloud cutover

1. Provision the self-hosted service with a unique replication stream while Electric Cloud remains
   connected. Confirm `/v1/health` reports `active` and the new slot is active with bounded lag.
2. Warm every named read model through the API proxy and verify Chat, Tasks, Workflows, Brain, Wiki,
   Skills, schedules, and integrations. Postgres is authoritative; no Electric data is copied.
3. Set prod `/api` `ELECTRIC_URL` to the Render private origin and switch `ELECTRIC_AUTH_MODE` to
   `self-hosted`. Keep both the self-hosted secret and Cloud source credentials during the
   observation window so rollback is a URL and auth-mode change, not secret recovery.
4. Redeploy the API and verify a new Chat message streams live, survives reload, and appears in the
   conversation list. Monitor API 502/503 responses, Electric logs/resources, disk usage, and
   replication lag.
5. Remove the old Cloud publication/slot and credentials only in a separately approved cleanup.

Render's persistent disk permits one Electric instance and causes a brief interruption during an
upgrade. Clients must be allowed to retry/refetch; do not add an application fallback that bypasses
the authorized read-model proxy.
