# Analytics

OpenCompany uses PostHog through the shared `@opencompany/analytics` package. Product code should
not import PostHog directly.

## Event registries

`packages/analytics/src/goat-events.ts` is the current product registry. It defines every event
name, allowed property shape, description, and safe property keys. Events cover app and onboarding
activity, Chat and Task use, integrations and Brain ingestion, model usage and spend, and billing
top-ups.

`packages/analytics/src/events.ts` is a separate billing-compatibility registry. It exists for the
shared Stripe and retained billing contracts and is not a second product analytics surface. Do not
add ordinary product events to it.

There is no separate `chat_started` event: the first Message is represented by
`chat_message_sent.is_first_message`. Before adding a new event, check the registry for an existing
signal that already answers the question.

## Privacy rules

Event payloads may contain internal entity IDs, selected enum values, counts, durations, model
metadata, and changed field names. OpenCompany identifies a person with the internal WorkOS user
ID; the allowlisted workspace and display fields may be set as person properties.

Do not send prompts, Messages, tool arguments or output, provider payloads, file contents, company
URLs, free-text onboarding answers, credentials, or other user-authored content. Lengths and counts
are acceptable where the registry permits them. Person properties must not be copied into ordinary
event properties unless the registry explicitly includes the field.

## Configuration

The current product project uses:

```bash
NEXT_PUBLIC_GOAT_POSTHOG_TOKEN=""
NEXT_PUBLIC_GOAT_POSTHOG_HOST=""
NEXT_PUBLIC_ANALYTICS_DEBUG="false"
```

The values must be available in every runtime that emits current product events: web, API, or
runner as required by `scripts/release-preflight.mjs`. Billing-compatibility values use
`NEXT_PUBLIC_POSTHOG_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` only in the retained emitters that still
consume that registry.

Analytics is optional for ordinary local development. Missing values make the package a no-op.
Set `NEXT_PUBLIC_ANALYTICS_DEBUG=true` to log sanitized event names and property keys locally
without requiring a PostHog project.

## Verification

With product PostHog values missing, exercise the changed flow and confirm there are no
analytics-related failures. With debug enabled, confirm logs contain only properties registered in
`goat-events.ts` and never print values for sensitive person fields. With hosted values, confirm the
event arrives in the product project once and does not also enter the billing-compatibility project.
