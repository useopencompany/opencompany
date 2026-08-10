# Runtime and Infrastructure

## Bun

**What it is:** JavaScript runtime, package manager, and script runner.

**What it does for us:** Bun owns dependency installation, workspace script execution, local dev
commands, production runner execution, and the lockfile.

**Where it is used:**

- `package.json` declares `packageManager: bun@1.3.2`.
- `bun.lock` is the committed dependency lockfile.
- `Dockerfile.runner` uses `oven/bun:1.3.2`.
- GitHub Actions uses `oven-sh/setup-bun@v2` with Bun `1.3.2`.
- Vercel install/build commands use Bun.

**Why we use it:** It keeps package management and runtime execution fast and consistent across the
monorepo. The runner also benefits from a single TypeScript-capable runtime path instead of a
separate compile step.

**Owner:** Platform.

**Reconsider if:** Bun compatibility blocks core Next.js, Vercel, Render, or dependency upgrades; or
runtime behavior diverges enough from Node.js that production incidents become hard to debug.

## Turborepo

**What it is:** Monorepo task runner.

**What it does for us:** Coordinates workspace-wide `dev`, `build`, `lint`, `typecheck`, and `test`
commands across `apps/*` and `packages/*`.

**Where it is used:**

- Root `package.json` scripts.
- `turbo.json`.
- Vercel build command `bun run vercel-build`.

**Why we use it:** The repo has several deployable apps and shared packages. Turbo gives us one
task graph instead of bespoke shell orchestration.

**Owner:** Platform.

**Reconsider if:** Task graph overhead outweighs value, caching becomes unreliable, or we move to a
build system that already owns the monorepo graph.

## Next.js

**What it is:** React framework for the web applications.

**What it does for us:** Hosts the product UIs, App Router routes, server actions, auth routes,
health checks, the surviving Goat Stripe webhook route, and the legacy Inngest endpoint.

**Where it is used:**

- `apps/goat` and `apps/goat/app`.
- `apps/goat/app/api/stripe/webhook/route.ts` (surviving webhook owner).
- `apps/goat/next.config.mjs`.
- `apps/web` and `apps/web/app` during the legacy-product retirement window.
- `apps/web/app/api/healthz/route.ts`.
- `apps/web/app/api/inngest/route.ts`.
- `apps/web/app/api/stripe/webhook/route.ts` remains available for cutover rollback.
- `apps/web/next.config.mjs`.

**Why we use it:** It gives us a production-ready web framework with server components/actions,
strong Vercel integration, and a single place for UI plus server-side product workflows.

**Owner:** Product Engineering.

**Reconsider if:** Server actions or framework coupling make core workflows hard to test, deploy, or
operate; or the app needs runtime characteristics that Vercel/Next cannot provide cleanly.

## Vercel

**What it is:** Hosting and deployment platform for the web apps.

**What it does for us:** Builds and deploys the separate Goat and legacy web projects, serves their
UIs and API routes, and is their release target in the production workflow.

**Where it is used:**

- `vercel.json`.
- `apps/goat/vercel.json`.
- `.github/workflows/release-production.yml`.
- `docs/deployment.md`.
- Infisical `/goat` and `/web` sync targets.

**Why we use it:** It is the natural deployment target for Next.js and keeps web hosting overhead
low while the product is changing quickly.

**Owner:** Platform.

**Reconsider if:** We need tighter runtime control, non-Next workloads dominate the web surface,
costs become unpredictable, or release ordering with the runner becomes too constrained.

## Render

**What it is:** Hosting platform for the long-lived agent runner.

**What it does for us:** Runs the Bun/Fastify runner as `opencompany-runner` with a health check and
API-triggered deploys controlled by GitHub Actions.

**Where it is used:**

- `render.yaml`.
- `Dockerfile.runner`.
- `.github/workflows/release-production.yml`.
- Infisical `/runner` sync target.

**Why we use it:** The runner is a live data plane for agent sessions, sandbox state, token streams,
abort state, and Durable Stream appends. It fits a long-lived service better than a short web
request lifecycle. We use a Docker image for this service because it gives Render a reproducible
runner artifact.

**Owner:** Platform.

**Reconsider if:** We need autoscaling semantics, regional placement, networking, logs, or runtime
control that Render cannot provide; or if the runner moves into a different orchestration platform.

## Fastify

**What it is:** HTTP server framework for Node/Bun.

**What it does for us:** Powers the runner API, `/healthz`, internal session run endpoints, abort
control, and browser-consumable session event streams.

**Where it is used:**

- `apps/runner/src/server.ts`.
- `apps/runner/src/index.ts`.

**Why we use it:** The runner needs a small, explicit HTTP service with good request handling and
low framework overhead.

**Owner:** Platform.

**Reconsider if:** Fastify/Bun compatibility becomes a production risk, or if the runner grows into
a larger service that benefits from a different framework or RPC contract.
