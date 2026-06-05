# Slack Connect after onboarding — direct line to the OC team

**Linear:** _(to create)_ · **Branch:** `spec/slack-connect`
**Date:** 2026-06-04

## Problem

After a customer finishes onboarding, there is no fast, human support channel. Email is
slow and the in-app agent is not a person. We want every new customer workspace to get a
**dedicated, private Slack Connect channel** shared with the OpenCompany team, so the
customer can ask questions and get answers in real time — in their own Slack, where they
already work.

The customer journey:

1. Customer finishes onboarding.
2. We automatically create a private channel `#oc-<workspace-slug>` in OpenCompany's Slack
   workspace, pull the OC support people in, and send the customer a **Slack Connect
   invite** (by email, the address we already have from onboarding).
3. Customer also sees a **"Join our Slack" button** on the onboarding-complete screen
   (same invite link).
4. Customer accepts in their own Slack → the channel now appears in both workspaces →
   customer and OC team chat in real time.

## What Slack Connect is (context for reviewers)

Slack Connect shares one channel between **two different Slack workspaces**. OC has its own
workspace; the customer has theirs. A shared channel shows up in both. The hard
precondition: **the customer must have a Slack workspace** — Slack Connect joins two
Slacks. Customers with no Slack cannot join; they get a fallback (book a call).

The whole backend is essentially three Slack API calls + one DB row:
`conversations.create` → `conversations.invite` (OC team) → `conversations.inviteShared`
(customer, external) → persist the channel↔workspace mapping.

## Scope

In scope (agreed — the **full automated per-customer flow**):

1. **Auto-create one private channel per customer workspace** on first onboarding
   completion, named `#oc-<workspace-slug>`.
2. **Invite the OC support team** into that channel (member IDs from config).
3. **Slack Connect invite to the customer by email** (primary) **and** a reusable
   **invite link** surfaced in the UI (secondary).
4. **Resend email** ("Louis from OpenCompany") containing the join link.
5. **Onboarding-complete UI card** with a "Join our Slack" button.
6. **Fallback for customers without Slack**: a quiet "No Slack? Book a call" link reusing
   the existing Cal.com booking.
7. **Persistence + idempotency**: a `workspace_slack_channels` table so we never create a
   second channel for the same workspace, and so the UI/email can read the invite link.

Explicitly **out of scope** (decided):

- No two-way message sync into the OC product UI. Slack stays in Slack.
- No per-customer routing/assignment of specific OC humans (one shared support member set
  for now).
- No reuse of the existing **Slack MCP OAuth** integration (`apps/web/lib/mcp/slack-oauth.ts`)
  — that is read-only agent tooling against the *customer's* Slack and is unrelated. This
  feature uses OC's **own** Slack app + bot token.
- No retry UI for failed channel creation beyond Inngest's automatic retries + a `failed`
  status the team can see.

## Prerequisite — one-time Slack app setup (config, not code)

Documented here so it is not forgotten; it blocks the feature working in any environment.

1. Create an OpenCompany Slack app in the OC Slack workspace.
2. Bot token scopes:
   - `groups:write` — create private channels, invite the support members, and stamp the
     owning workspace into the channel purpose (`opencompany-support:<workspaceId>`).
   - `groups:read` — on a `name_taken` retry, look up the channel by name AND verify its
     purpose marks THIS workspace before adopting it. A channel marked for a different
     workspace (a slug+suffix collision) is refused, so a crashed attempt's orphan is
     recovered without ever hijacking another tenant's channel.
   - `chat:write` — post a welcome message.
   - `conversations.connect:write` (a.k.a. the Slack Connect write capability) — send
     external shared-channel invites. **Note:** Slack may require app review / org approval
     before `inviteShared` works in production. Flag this risk early; it can gate the
     production rollout (dev/sandbox works without review).
3. Install the app, grab the **bot token** and the OC **team ID**.
4. Collect the Slack **member IDs** of the OC support people to auto-invite.

New env vars (add to `.env.example` + `docs/env-vars.md`):

```bash
SLACK_SUPPORT_BOT_TOKEN=""        # xoxb-… OC support app bot token
SLACK_SUPPORT_TEAM_ID=""          # OC Slack workspace/team id (T…)
SLACK_SUPPORT_MEMBER_IDS=""       # comma-separated U… ids of OC support members to invite
```

These are distinct from the existing `SLACK_MCP_CLIENT_ID/SECRET` (the MCP OAuth flow).

## Existing building blocks (reuse, do not reinvent)

- **Onboarding completion**: `apps/web/lib/onboarding/actions.ts` → `completeOnboarding`.
  It already fires analytics `onboarding_completed` and runs first-time-only logic
  (`startSeededAgentSession`). We hook the Slack provisioning into the **first-onboarding**
  branch, dispatched as an Inngest event (do not block the action's redirect on Slack).
- **Inngest pattern**: `apps/web/lib/inngest/functions.ts` (see `sendSignupWelcome`) +
  `apps/web/lib/inngest/client.ts`. Event-triggered function, `concurrency` keyed by
  workspace, idempotency key per workspace, registered in the `inngestFunctions` array.
- **Email pattern**: `apps/web/lib/email/signup-welcome.ts` + `events.ts`. Resend SDK,
  hand-rendered HTML, dispatched via an Inngest event, idempotency key. Mirror this for the
  Slack-invite email.
- **Credential encryption** (if we ever store per-workspace Slack tokens): `packages/crypto`
  + `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`. For this feature the bot token is a single
  app-level env secret, so no encryption table is needed.
- **Drizzle schema**: `packages/db/src/schema.ts`. Tables `workspaces`,
  `workspace_memberships`, `users`, `workspace_integrations`. We add one table.
- **Cal.com booking** already embedded in the onboarding final step (PR #250) — reuse for
  the no-Slack fallback link.

## Design

### 1. Data model — `workspace_slack_channels`

New Drizzle table (one row per workspace, `workspaceId` unique → idempotency):

| Column            | Type        | Notes                                             |
|-------------------|-------------|---------------------------------------------------|
| `id`              | uuid pk     |                                                   |
| `workspaceId`     | fk, unique  | one channel per workspace                         |
| `slackChannelId`  | text null   | `C…`, set once created                            |
| `slackTeamId`     | text null   | OC team id (denormalized for link building)       |
| `inviteUrl`       | text null   | Slack Connect shared invite URL                   |
| `status`          | enum        | `pending` \| `active` \| `failed`                 |
| `error`           | text null   | last failure reason (for `failed`)                |
| `createdAt`       | timestamptz | default now                                       |
| `updatedAt`       | timestamptz |                                                   |

Migration via Drizzle (`bun run db:generate` then `db:migrate`). QA on a branch DB needs
`db:migrate` (per repo convention).

### 2. Slack client — `apps/web/lib/slack/support-client.ts`

Thin wrapper around `@slack/web-api` `WebClient` constructed from
`SLACK_SUPPORT_BOT_TOKEN`. One purpose: provision a support channel. Public surface:

- `provisionSupportChannel({ workspace, customerEmail }) → { channelId, inviteUrl }`
  1. `conversations.create({ name: oc-<slug>, is_private: true })` — slugify workspace
     name; on `name_taken` fall back to `oc-<slug>-<shortid>`.
  2. `conversations.invite({ channel, users: SLACK_SUPPORT_MEMBER_IDS })`.
  3. `conversations.inviteShared({ channel, emails: [customerEmail] })` → returns the
     external invite; capture the shareable `invite_url`/link.
  4. `chat.postMessage` — a short "👋 This is your private support channel with
     OpenCompany" intro.
  Returns the channel id + invite url. Throws typed errors the Inngest fn maps to `failed`.

Keep all Slack SDK calls behind this one module so the rest of the app never imports
`@slack/web-api` directly (testability + a single seam to mock).

### 3. Trigger — Inngest function `provisionSlackSupportChannel`

- Event: `slack.support_channel_requested` with `{ workspaceId, userId, customerEmail }`,
  dispatched from `completeOnboarding` **only on first onboarding** (mirrors the existing
  first-time branch). Dispatch is fire-and-forget; onboarding redirect is unaffected.
- Function (`apps/web/lib/inngest/functions.ts`):
  - `concurrency: { limit: 1, key: "event.data.workspaceId" }`, `retries: 3`.
  - Idempotency key `slack-support:{workspaceId}`.
  - `step.run("ensure-row")`: upsert `workspace_slack_channels` row as `pending`; if a row
    already has `status = active`, **short-circuit** (return existing) — no duplicate
    channel.
  - `step.run("provision")`: call `provisionSupportChannel`. On success → update row to
    `active` with `slackChannelId`/`slackTeamId`/`inviteUrl`. On failure → row `failed` +
    `error`, then rethrow so Inngest retries.
  - `step.run("dispatch-email")`: send `email.slack_invite_requested` event.
- Registered in the `inngestFunctions` array.

### 4. Email — `apps/web/lib/email/slack-invite.ts`

> **Superseded (2026-06-05):** the custom invite email was removed. `conversations.inviteShared`
> with the customer's email already makes **Slack send its own transactional Connect invite**, so a
> separate branded email would double up. The invite URL is still persisted for the workspace-home
> card. The original design below is kept for context.

Mirror `signup-welcome.ts`: an Inngest fn `sendSlackInvite` on
`email.slack_invite_requested`, Resend send from the existing "Louis" sender,
idempotency `slack-invite:{workspaceId}`. Body: one-paragraph "here's your direct line to
the team" + a button linking to `inviteUrl`. Reuses the existing hand-rendered HTML helper
style (no new template engine). If `inviteUrl` is null/`failed`, skip the email.

### 5. Frontend — onboarding-complete card

- A server component/section on the onboarding-complete view reads
  `workspace_slack_channels` for the current workspace.
- States:
  - `active` + `inviteUrl` → card "Direct line to the OC team" + primary button **Join our
    Slack** (opens `inviteUrl` in a new tab) + quiet "No Slack? Book a call" link
    (Cal.com).
  - `pending` (channel still provisioning) → "Setting up your Slack channel…" with the
    booking link as the immediate fallback. (Provisioning is usually a few seconds; the
    email arrives when ready, so the UI does not need live polling for v1.)
  - `failed` / no row → just the "Book a call" fallback (no broken Slack button).
- Respect the repo's **max-2-buttons** onboarding rule (memory): one real button (Join
  Slack), the booking is a quiet link.

### 6. Error handling & idempotency

- `workspaceId` unique constraint + the `active` short-circuit guarantee one channel per
  customer even under retries or double event dispatch.
- Slack errors are typed in the client and mapped to a `failed` row; Inngest retries
  transient errors. A persistent `failed` row degrades gracefully to the booking fallback
  — the customer is never shown a dead button.
- Missing env (`SLACK_SUPPORT_BOT_TOKEN` empty, e.g. local dev) → the provision step
  no-ops to `failed` with a clear `error` and logs a warning, rather than throwing on every
  onboarding. The feature is effectively off until configured.

### 7. Security & privacy

- Channels are **private** — customers never see each other.
- Bot token is a single app-level secret (env), never sent to the client. Only `inviteUrl`
  (already a shareable Slack link) reaches the browser.
- We email the invite to the onboarding email only. No new PII stored beyond Slack channel
  metadata.

## Testing

- **vitest** (repo standard): unit-test the slug/name-collision logic and the Inngest
  function with `provisionSupportChannel` mocked (success / `name_taken` / Slack error /
  already-active short-circuit / missing-env no-op).
- Email render test mirrors the signup-welcome test.
- Real browser QA per repo convention: trigger onboarding completion against a Slack
  **sandbox/dev** app, confirm the channel is created, the invite email arrives, and the
  onboarding card shows the working Join button. Screenshot → PR body.

## Rollout / phasing

Single feature, but de-risk the Slack-review dependency by sequencing:

1. **Plumbing + sandbox**: DB table, client, Inngest fn, email, UI — wired against a Slack
   **dev** app where `inviteShared` works without review. Fully testable.
2. **Production enablement**: submit the app for the Connect-write capability if Slack
   requires it; flip env vars in prod. No code change — just the prerequisite clearing.

## Open questions

1. Workspace slug source — is there an existing slug on `workspaces`, or do we slugify the
   display name? (Confirm against `packages/db/src/schema.ts` during planning.)
2. Should a re-onboarding (existing workspace) ever re-trigger provisioning, or strictly
   first-onboarding-only? (Spec assumes first-only; the `active` short-circuit makes
   re-trigger safe regardless.)
3. Does Slack require app review for `conversations.connect:write` on OC's plan? Determines
   whether Phase 2 has a lead-time blocker.
