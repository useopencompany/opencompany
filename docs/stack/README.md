# Technology stack

| Area | Technology | Responsibility |
| --- | --- | --- |
| Monorepo | Bun, Turborepo | dependency management and task orchestration |
| Presentation | Next.js, React | opencompany web UI and browser-authentication shell |
| Product API | Bun, Hono | authenticated `/v1` resources, provider ingress, SSE, OpenAPI, and read models |
| Durable execution | Bun, Fastify | runner workers, sandboxes, recovery, and internal transports |
| Database | Neon Postgres, Drizzle | branch-isolated state and checked-in migrations |
| Live data | Electric, TanStack DB | authorized API-owned read models |
| Authentication | WorkOS AuthKit | browser sessions and API identity |
| Models | Vercel AI Gateway, AI SDK | runner model access and API-owned Auto routing |
| Sandboxes | E2B, Vercel Sandbox | cloud coding and browser-capable chat workspaces |
| Hosting | Vercel, Render | web/marketing on Vercel; API/runner on Render |
| Secrets | Infisical | development and production environment authority |
| Observability | Better Stack/Sentry, SigNoz, Latitude | errors, logs, traces, and LLM telemetry |

Package-level responsibilities are described in [Architecture](../architecture.md), while current
opencompany execution paths are documented in [the system map](../../apps/web/docs/README.md).
