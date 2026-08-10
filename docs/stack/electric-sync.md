# Electric sync

The web app uses Electric shapes through `apps/web/app/api/electric/v1/shape`. Browsers never receive
database credentials or talk directly to the Electric service; the route authenticates the user
and limits every shape to its supported table and workspace/user scope.

Collections live under `apps/web/lib/electric*` and provide live state for chat sessions,
messages, tasks, workflows, integrations, Brain documents, and related UI projections. Durable
runner turns persist their state to Postgres; Electric delivers those committed rows to web.

Local setup starts a self-hosted Electric container when Docker or OrbStack is available and writes
`ELECTRIC_URL` for web. Run `bun run electric:dev` to keep Electric in the foreground. Hosted web
uses either `ELECTRIC_URL` plus `ELECTRIC_TOKEN`, or Electric Cloud source credentials. Electric
must connect to the direct Neon endpoint with logical replication enabled.
