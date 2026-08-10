# Technology stack

| Area | Technology | Responsibility |
| --- | --- | --- |
| Monorepo | Bun, Turborepo | dependency management and task orchestration |
| Product | Next.js, React | OpenCompany web UI, API routes, auth callbacks, webhooks |
| Durable services | Bun, Fastify | Goat runner workers and internal transports |
| Database | Neon Postgres, Drizzle | branch-isolated state and checked-in migrations |
| Live data | Electric, TanStack DB | authorized Goat database shapes |
| Authentication | WorkOS AuthKit | browser sessions and API identity |
| Models | Vercel AI Gateway, AI SDK | foreground and runner model access |
| Sandboxes | E2B, Vercel Sandbox | cloud coding and browser-capable chat workspaces |
| Hosting | Vercel, Render | web/marketing and runner respectively |
| Secrets | Infisical | development and production environment authority |
| Observability | Better Stack/Sentry, SigNoz, Latitude | errors, logs, traces, and LLM telemetry |

Package-level responsibilities are described in [Architecture](../architecture.md), while current
OpenCompany execution paths are documented in [the system map](../../apps/web/docs/README.md).
