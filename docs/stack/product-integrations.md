# Product Integrations

## WorkOS AuthKit

**What it is:** Authentication and organization management.

**What it does for us:** Handles sign-in/sign-up, callback flow, cookie-backed sessions, WorkOS
organizations, and local workspace provisioning.

**Where it is used:**

- `apps/web/lib/workos.ts`.
- `apps/web/lib/auth.ts`.
- `apps/web/proxy.ts`.
- `apps/web/app/auth/*`.
- `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`,
  `NEXT_PUBLIC_WORKOS_REDIRECT_URI` in `.env.example`.
- `docs/auth.md`.

**Why we use it:** It gives us an enterprise-friendly auth/org foundation without building identity,
SSO, or organization primitives ourselves.

**Owner:** Product Engineering.

**Reconsider if:** We need a materially different identity model, pricing becomes misaligned, or a
customer requirement pushes us toward another auth provider.

## Stripe

**What it is:** Payments platform.

**What it does for us:** Handles Goat subscriptions, credit top-up Checkout sessions, off-session
auto-refill, and retained legacy-customer billing compatibility. App-side billing records track
pending/open/fulfilled Checkout state, subscription projections, and workspace balances. The Goat
webhook is the durable confirmation point for those flows.

**Where it is used:**

- `apps/goat/lib/billing/stripe.ts`.
- `apps/goat/app/api/stripe/webhook/route.ts` (surviving webhook owner).
- `apps/goat/lib/billing/legacy-*` (isolated legacy-customer compatibility).
- `apps/web/lib/billing/*` and `apps/web/app/api/stripe/webhook/route.ts` remain deployed only for
  the documented cutover rollback window.
- `apps/stripe-webhooks`.
- `scripts/stripe-listen.mjs`.
- `GOAT_STRIPE_API_KEY`, `GOAT_STRIPE_WEBHOOK_SECRET`, `GOAT_STRIPE_CHECKOUT_ENABLED`, and the
  rollback-window `STRIPE_*` values in `.env.example`.
- `docs/legacy-product-retirement.md`.

**Why we use it:** Stripe Checkout keeps the payment surface small and lets us avoid handling card
details directly. Webhooks give us a durable fulfillment point for credits.

**Owner:** Product Engineering / Finance.

**Reconsider if:** Tax, marketplace payouts, revenue recognition, or separating current and legacy
customers into different Stripe accounts materially changes the billing model. Those should be
explicit Stripe architecture decisions, not organic extensions to the webhook.

## Linear

**What it is:** Issue tracker and product feedback destination.

**What it does for us:** In-app feedback creates Linear issues with labels and optional project
routing.

**Where it is used:**

- `apps/web/lib/feedback/actions.ts`.
- `apps/web/components/FeedbackDialog.tsx`.
- `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_FEEDBACK_PROJECT_ID`,
  `LINEAR_FEEDBACK_LABELS` in `.env.example`.
- `docs/feedback-intake.md`.

**Why we use it:** It routes user feedback into the same system where engineering work is triaged,
instead of leaving feedback in email, chat, or an app-only table.

**Status:** Optional. Missing Linear env vars should affect feedback submission, not core app
runtime.

**Owner:** Product / Engineering.

**Reconsider if:** Feedback volume requires a dedicated support/product feedback tool, or Linear is
no longer the operating system for product engineering work.

## PostHog

**What it is:** Product analytics platform.

**What it does for us:** Captures typed client and server events through the repo-owned
`@opencompany/analytics` facade.

**Where it is used:**

- `packages/analytics/src/events.ts`.
- `packages/analytics/src/goat-events.ts`.
- `packages/analytics/src/client.tsx`.
- `packages/analytics/src/goat-client.tsx`.
- `packages/analytics/src/server.ts`.
- `packages/analytics/src/goat-server.ts`.
- `apps/web/instrumentation-client.ts`.
- `apps/goat/components/GoatAppShell.tsx`.
- Legacy `NEXT_PUBLIC_POSTHOG_*` and dedicated `NEXT_PUBLIC_GOAT_POSTHOG_*` project values in
  `.env.example`, with `NEXT_PUBLIC_ANALYTICS_DEBUG` for local payload inspection.
- `docs/analytics.md`.

**Why we use it:** We need a lightweight way to understand product behavior and debug onboarding or
usage funnels without hardwiring analytics code throughout the app.

**Status:** Optional. Missing PostHog env vars make analytics a no-op.

**Owner:** Product.

**Reconsider if:** Analytics needs move toward warehouse-native analysis, stricter data residency,
feature flags/session replay, or a customer-facing audit requirement.
