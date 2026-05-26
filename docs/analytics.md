# Analytics

We use PostHog through the shared `@opencompany/analytics` package. App code should not import PostHog directly.

## Event registry

`packages/analytics/src/events.ts` is the source of truth for implemented events. It defines:

- every event name
- the allowed property shape for each event
- a short description
- the safe property keys for review

When adding an event, update that file first, then import the typed client or server capture helper.

## Privacy rules

Event payloads should only send coarse product data:

- internal user, workspace, and entity IDs
- selected enum values
- counts and changed field names

PostHog person profiles are identified with internal user/workspace IDs plus email, first name, last name, and display name from WorkOS. This keeps PostHog usable for support and product debugging without putting PII on every event.

Do not send company URLs, free-text onboarding answers, agent content, editor documents, prompts, or other user-authored content.

## Environment

Analytics is optional in local development. Missing PostHog values make the package a no-op.

```bash
NEXT_PUBLIC_POSTHOG_TOKEN=""
NEXT_PUBLIC_POSTHOG_HOST=""
NEXT_PUBLIC_ANALYTICS_DEBUG="false"
```

Set `NEXT_PUBLIC_ANALYTICS_DEBUG=true` to log sanitized event payloads locally without requiring a PostHog project.

## Verification

With PostHog env vars missing, exercise signup, onboarding, agent creation, agent editing, and sign-out and confirm the app has no analytics-related errors.

With debug enabled, confirm `[analytics]` logs appear with only safe properties.

With real PostHog env vars, confirm at least one client event and one server event appears in PostHog.

Reverse proxy, session replay, error tracking, feature flags, and automatic pageview tracking are intentionally deferred.
