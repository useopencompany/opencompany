# Technology Stack

This register is the operational map for the major technologies OpenCompany uses, why they are in
the stack, where they show up, and what would make us reconsider them. Source files, manifests,
deployment config, and vendor dashboards remain authoritative for exact runtime behavior.

It is intentionally more operational than promotional. This is not a package inventory. A technology
belongs here when it introduces a production dependency, a data boundary, a security boundary, a paid
vendor, or a core architecture choice.

If a library only helps render one UI control, format one kind of output, or glue another stack
choice into the app, keep it in the package manifest and local code comments instead of this
register.

## How to use this register

When adding a meaningful dependency, vendor, or platform choice:

1. Add or update the relevant stack entry.
2. Explain the job the technology does for us.
3. Link to the code, config, docs, dashboard, or runbook that makes the usage concrete instead of
   duplicating volatile details.
4. Call out the owner and the exit trigger.
5. Keep the root overview table current.

Use these statuses:

| Status | Meaning |
|---|---|
| Active | Required for the product or release process today. |
| Optional | Supported, but the app degrades safely when missing. |
| Dev-only | Used for local development, tests, checks, or CI only. |
| Deferred | Deliberately not in use yet, but documented as a boundary or future consideration. |

Default owners are placeholders until an explicit team/person exists. If ownership is unclear, do not
hide it; write `Engineering / unassigned` so we can fix it.

## Stack overview

| Technology | Category | Status | Used for | Owner | Detail |
|---|---|---:|---|---|---|
| Bun | Runtime/package manager | Active | Monorepo scripts, dependency installation, web/runner execution | Platform | [Runtime and infrastructure](./runtime-and-infra.md#bun) |
| Turborepo | Monorepo orchestration | Active | Workspace-wide dev, build, lint, typecheck, and test tasks | Platform | [Runtime and infrastructure](./runtime-and-infra.md#turborepo) |
| Next.js | Web framework | Active | App Router web app, server actions, API routes, auth callbacks | Product Engineering | [Runtime and infrastructure](./runtime-and-infra.md#nextjs) |
| Vercel | Web hosting/release target | Active | Production web deployment and release control plane | Platform | [Runtime and infrastructure](./runtime-and-infra.md#vercel) |
| Render | Runner hosting | Active | Long-lived Bun/Fastify agent runner | Platform | [Runtime and infrastructure](./runtime-and-infra.md#render) |
| Fastify | Runner HTTP server | Active | Runner API, health check, and session event streams | Platform | [Runtime and infrastructure](./runtime-and-infra.md#fastify) |
| Neon Postgres | Database | Active | Primary relational database and per-branch dev databases | Platform | [Data and state](./data-and-state.md#neon-postgres) |
| Drizzle ORM / Drizzle Kit | Database access/migrations | Active | Typed schema, queries, generated SQL migrations | Platform | [Data and state](./data-and-state.md#drizzle) |
| GitHub App | Workspace storage integration | Active | Managed private repos and async agent materialization | Product Engineering | [Data and state](./data-and-state.md#github-app) |
| Inngest | Background jobs | Active | Agent sync and message-run dispatch | Platform | [Data and state](./data-and-state.md#inngest) |
| Infisical | Secrets management | Active | Runtime and release secret source of truth | Platform / Security | [Quality and operations](./quality-and-ops.md#infisical) |
| GitHub Actions | CI/CD | Active | CI gates and serialized production release workflow | Platform | [Quality and operations](./quality-and-ops.md#github-actions) |
| TruffleHog | Secret scanning | Active | CI secret detection | Security | [Quality and operations](./quality-and-ops.md#trufflehog) |
| Quality toolchain | Engineering standards | Active | Type checking, formatting, linting, unit tests, local E2E tests | Platform | [Quality and operations](./quality-and-ops.md#quality-toolchain) |
| Better Stack + Sentry SDKs | Error capture | Optional | Sentry-compatible error reporting for web and runner | Platform | [Quality and operations](./quality-and-ops.md#better-stack-and-sentry-sdks) |
| WorkOS AuthKit | Authentication/orgs | Active | Sign-in, callback, sessions, organization membership | Product Engineering | [Product integrations](./product-integrations.md#workos-authkit) |
| Stripe Checkout | Billing | Active | Workspace credit top-ups and webhook fulfillment | Product Engineering / Finance | [Product integrations](./product-integrations.md#stripe) |
| Linear | Feedback intake | Optional | In-app feedback creates Linear issues | Product / Engineering | [Product integrations](./product-integrations.md#linear) |
| PostHog | Product analytics | Optional | Client/server analytics through `@opencompany/analytics` | Product | [Product integrations](./product-integrations.md#posthog) |
| Vercel AI Gateway | Model gateway | Active | Provider-neutral model calls for agent runs | AI Platform | [AI and agent runtime](./ai-and-agent-runtime.md#vercel-ai-gateway) |
| AI SDK | Model orchestration library | Active | `generateText`, gateway client, usage accounting | AI Platform | [AI and agent runtime](./ai-and-agent-runtime.md#ai-sdk) |
| Gateway model providers | Model providers | Active | Fast/deep model families exposed through AI Gateway | AI Platform | [AI and agent runtime](./ai-and-agent-runtime.md#gateway-model-providers) |
| E2B | Agent sandboxes | Active | Isolated runtime workspaces for shell/file/git tools | AI Platform | [AI and agent runtime](./ai-and-agent-runtime.md#e2b) |
| Exa | Hosted web search | Optional | Agent `@exa` search and web fetch tooling | AI Platform | [AI and agent runtime](./ai-and-agent-runtime.md#exa) |

## Repo-owned boundaries

These are not vendor choices, but they are the local ownership boundaries that keep the stack from
turning into cross-app imports:

| Package | Purpose | Used by |
|---|---|---|
| `@opencompany/db` | Shared Drizzle schema, relations, and database client | Web, runner, scripts |
| `@opencompany/agent-runtime` | Agent file/runtime types, model catalog, tool definitions, tokens | Web, runner |
| `@opencompany/billing` | Credit accounting helpers and model usage cost logic | Web, runner |
| `@opencompany/analytics` | Typed PostHog client/server facade and event registry | Web |
| `@opencompany/observability` | Structured logging and exception capture facade | Web, runner, packages |

## Related docs

- [Architecture](../architecture.md)
- [Database](../database.md)
- [Deployment](../deployment.md)
- [Secret management](../secret-management.md)
- [Environment variables](../env-vars.md)
- [Auth](../auth.md)
- [Analytics](../analytics.md)
- [Observability](../observability.md)
- [Runner](../runner.md)
