# Analytics

We use PostHog through the shared `@opencompany/analytics` package. App code should not import
PostHog directly.

The legacy web app and Goat send to separate PostHog projects. The shared package only reuses the
transport and privacy conventions; each product has its own event registry and project token.

## Event registries

- `packages/analytics/src/events.ts` is the legacy web event registry.
- `packages/analytics/src/goat-events.ts` is the Goat event registry.

Each registry defines every event name, its allowed property shape, a description, and the safe
property keys reviewers should expect.

Goat's product events are:

| Event | Purpose |
| --- | --- |
| `app_opened` | Signed-in active users |
| `signup_completed` | New-user conversion |
| `chat_message_sent` | Main-chat engagement across OpenCompany, Codex, and Claude Code engines; `is_first_message` also measures new chats |
| `integration_added` | Integration activation |
| `brain_source_added` | A new enabled integration source was attached to a Brain |
| `brain_ingestion_completed` | A full Brain ingestion job completed successfully |
| `billing_topup_completed` | Credits were added manually or by auto-refill; `topup_type` distinguishes the path and `amount_usd` can be summed for daily revenue |

There is no separate `chat_started` event because it would double-count the first message. Goat
does not capture pageviews, page leaves, clicks, dead clicks, heatmaps, exceptions, performance,
feature flags, surveys, product tours, conversations, or session recordings.

## Privacy rules

Event payloads should only send coarse product data:

- internal user, workspace, and entity IDs
- selected enum values
- counts and changed field names

Goat identifies people with the internal WorkOS user ID. It sets workspace ID, email, first name,
last name, and display name as person properties so activity remains attributable across browser
and server-side events. These allowlisted identity fields may be set through the browser
`identify()` call or PostHog's server-side `$set`; they must not be copied into ordinary event
properties.

Do not send company URLs, free-text onboarding answers, agent content, editor documents, prompts,
or other user-authored content. `message_length` is allowed; message content is not.

## Project setup and environment

Create a PostHog project named `Goat` in the same PostHog organization as the legacy web project.
Do not reuse the legacy project's token.

Store the Goat project's API host and project token in:

- Infisical `prod` + `/goat`, synced to the Goat Vercel project
- Infisical `prod` + `/web`, synced temporarily to the legacy Vercel project for the Stripe
  cutover rollback route
- Infisical `prod` + `/runner`, synced to Render for completed Brain ingestion events
- Infisical `dev` + `/web` when local Goat analytics are needed
- Infisical `dev` + `/runner` when local Brain ingestion analytics are needed

Analytics is optional in ordinary local development. Missing values make the package a no-op.

```bash
# Legacy web project
NEXT_PUBLIC_POSTHOG_TOKEN=""
NEXT_PUBLIC_POSTHOG_HOST=""

# Dedicated Goat project
NEXT_PUBLIC_GOAT_POSTHOG_TOKEN=""
NEXT_PUBLIC_GOAT_POSTHOG_HOST=""

NEXT_PUBLIC_ANALYTICS_DEBUG="false"
```

Set `NEXT_PUBLIC_ANALYTICS_DEBUG=true` to log sanitized event payloads locally without requiring a
PostHog project.

## Verification

With Goat PostHog values missing, exercise signup, app load, chat, and integration connection and
confirm the app has no analytics-related errors.

With debug enabled, confirm analytics logs contain only the event properties registered in
`goat-events.ts`. Person-property updates should log their property names, never their values.

With the real Goat project values, confirm the explicit events exercised by the app, shared Stripe
webhook, and runner appear in the Goat project, and that none appear in the legacy web project.
