# Electric sync

The web app uses Electric through authenticated server-owned proxies. Canonical domains select a
fixed name under `/v1/read-models/{readModel}`; domains still awaiting cutover use the compatibility
route at `apps/web/app/api/electric/v1/shape`. Browsers never receive database credentials or talk
directly to Electric. The selected proxy owns the physical table, columns, predicate, and tenant
parameters.

Collections live under `apps/web/lib/electric*` and the domain-specific headless collection modules.
Chat sessions, messages, Tasks, Workflows, schedules, Brain documents, Brain ingestion activity,
Wiki pages, Skills, integrations, and related projections use these live paths. Durable runner turns
and ingestion workers persist their state to Postgres; Electric delivers those committed rows to
web.

`brain-ingest-jobs-v1` exposes only the activity state and bounded, normalized result fields rendered
by the Brain UI. Source metadata is resolved separately through the authorized, 100-ID-bounded
`GET /v1/brains/{brainId}/source-items` resource. Worker leases, actor identifiers, provider payloads,
integration locators, and unrendered result data never cross either boundary.

Local setup starts a self-hosted Electric container when Docker or OrbStack is available and writes
`ELECTRIC_URL` for web. Run `bun run electric:dev` to keep Electric in the foreground. Hosted web
uses either `ELECTRIC_URL` plus `ELECTRIC_TOKEN`, or Electric Cloud source credentials. Electric
must connect to the direct Neon endpoint with logical replication enabled.
