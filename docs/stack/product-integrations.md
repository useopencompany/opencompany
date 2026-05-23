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

**What it does for us:** Handles credit top-up checkout sessions and webhook confirmation. App-side
billing records track pending/open/fulfilled checkout state and workspace balances.

**Where it is used:**

- `apps/web/lib/billing/stripe.ts`.
- `apps/web/lib/billing/actions.ts`.
- `apps/web/lib/billing/service.ts`.
- `apps/web/app/api/stripe/webhook/route.ts`.
- `apps/stripe-webhooks`.
- `scripts/stripe-listen.mjs`.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CLI_PROJECT_NAME` in `.env.example`.

**Why we use it:** Stripe Checkout keeps the payment surface small and lets us avoid handling card
details directly. Webhooks give us a durable fulfillment point for credits.

**Owner:** Product Engineering / Finance.

**Reconsider if:** We need subscriptions, invoices, tax, marketplace payouts, or revenue recognition
that changes the billing model. Those should be explicit Stripe architecture decisions, not organic
extensions to top-ups.

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
- `packages/analytics/src/client.tsx`.
- `packages/analytics/src/server.ts`.
- `apps/web/instrumentation-client.ts`.
- `NEXT_PUBLIC_POSTHOG_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST`,
  `NEXT_PUBLIC_ANALYTICS_DEBUG` in `.env.example`.
- `docs/analytics.md`.

**Why we use it:** We need a lightweight way to understand product behavior and debug onboarding or
usage funnels without hardwiring analytics code throughout the app.

**Status:** Optional. Missing PostHog env vars make analytics a no-op.

**Owner:** Product.

**Reconsider if:** Analytics needs move toward warehouse-native analysis, stricter data residency,
feature flags/session replay, or a customer-facing audit requirement.
