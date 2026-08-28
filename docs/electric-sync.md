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
