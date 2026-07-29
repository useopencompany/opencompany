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

Goat starts with four product events:

| Event | Purpose |
| --- | --- |
| `app_opened` | Signed-in active users |
| `signup_completed` | New-user conversion |
| `chat_message_sent` | Chat engagement and conversation depth; `is_first_message` also measures new chats |
| `integration_added` | Integration activation |

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
- Infisical `dev` + `/web` when local Goat analytics are needed

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

With the real Goat project values, confirm one `app_opened` client event and one
`chat_message_sent` server event appear in the Goat project, and that neither appears in the legacy
web project.
