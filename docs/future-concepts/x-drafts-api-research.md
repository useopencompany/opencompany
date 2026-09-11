# Saving Draft Posts to a Connected X Account

Status: researched recommendation, do not build
Date: 2026-09-11

This is a constraint on future proposals rather than a proposal to build something.

## Question

Can opencompany save a draft post into a connected user's X account, so the draft is waiting for
them in the X composer? Several social tools advertise "X drafts", which suggests an API exists.

## Answer

No. There is no public X API that writes a draft post to a user's X account. Every tool that
advertises "X drafts" either stores the draft in its own product, or is using the Ads API's
promoted-creative drafts, which are a different object in a different surface.

The one exception is long-form Articles, which are not regular posts.

## API reality

**1. X API v2 has no draft state for regular posts.** `POST /2/tweets` publishes immediately. There
is no draft flag and no `scheduled_at` parameter, and our `create_posts` schema is a strict object
that already rejects a hallucinated `draft: true`. Source:
[Create Post](https://docs.x.com/x-api/posts/create-post).

**2. The only v2 draft endpoint is for Articles.** `POST https://api.x.com/2/articles/draft` creates
an unpublished long-form Article from a DraftJS content state, and
`POST https://api.x.com/2/articles/{article_id}/publish` publishes it. This is real, it uses ordinary
user auth with `tweet.read`, `tweet.write`, and `users.read`, and it is the only place X lets an API
client park unpublished content on an account. It does not help with regular posts: Articles are a
separate long-form surface, not a post draft. Source:
[Articles endpoints](https://docs.x.com/x-api/articles/introduction).

This is also what X's own hosted MCP server means when its tool table lists "Create draft Articles
and publish them". The vendored X plugin snapshot in
`packages/agent-runtime/src/test-fixtures/plugins/x/` agrees: across its whole tool list,
`articleCreateDraft` is the only tool with "draft" in its name. If someone saw an agent tool that
drafts on X, this is most likely it. Source: [X MCP Server](https://docs.x.com/tools/mcp).

**3. Draft posts do exist in the Ads API, and they are not the user's drafts.** X Ads API v12 has
full CRUD on `https://ads-api.x.com/12/accounts/:account_id/draft_tweets`, plus a device-preview
call. This is the endpoint people find when they search for a draft tweet API. It is unusable for
our job:

- It requires an approved Ads API access application, reviewed by X in up to three business days.
- It requires an ads account id, and an `as_user_id` promotable user who has granted our handle
  access through ads.x.com. A founder connecting X in Settings has granted us none of that.
- `nullcast` defaults to `true`, so the created draft is a Promoted-only creative.
- Media must already be in the ads account's Media Library, not our normal media upload path.
- The draft lives in the ads creative composer, not the X app's Drafts. The docs make this
  concrete: to see one on a phone you have to call
  `POST accounts/:account_id/draft_tweets/preview/:draft_tweet_id`, which pushes a notification to
  the authenticated user's devices that opens a one-off preview timeline.

Source: [Ads API creatives reference](https://docs.x.com/x-ads-api/creatives/reference).

**4. Third-party "X drafts" are the vendor's own drafts.** Typefully, Buffer, and similar schedulers
keep drafts in their own product and later publish through the normal post endpoint. None of them
documents writing into X's drafts, because none of them can. Typefully's public API exposes its own
drafts, not X's, and its marketing makes the boundary explicit: it sells reliable draft sync as the
fix for X's native drafts being unreliable for threads with media, which only makes sense if it is
not writing into X's drafts at all. Sources:
[Typefully API](https://typefully.com/docs/api),
[Typefully on X draft sync](https://typefully.com/blog/sync-x-twitter-drafts-web-mobile).

**5. X's native drafts do sync across devices, but only through X's internal API.** Drafts started on
mobile now appear on web. That sync runs over the undocumented GraphQL API that X's own clients use.
It is not documented, not authorized for third parties, and would require driving a logged-in session
rather than our OAuth connection. Building on it would be brittle and a terms violation, so it is not
an option. The sync itself is reported by third parties rather than by X's developer docs, which say
nothing about drafts at all. Source:
[Typefully on X draft sync](https://typefully.com/blog/sync-x-twitter-drafts-web-mobile).

## What this means for opencompany

The draft belongs in opencompany, not on X. This is the same conclusion the current code already
encodes, and the research confirms it rather than changing it:

- `create_posts` is a `write` capability that defaults to `ask`, so the user sees the exact text and
  approves before anything is published. That approval step already does the job a draft would do.
- The tool description tells the model to never use `create_posts` for a draft request, and the
  strict schema rejects a `draft` parameter outright.
- When a founder asks for a draft, the right behavior is to write it in chat, let them edit it there,
  and publish only on their word.

Do not add an "X drafts" capability, and do not present anything to the user as being saved to their
X drafts. We cannot deliver that, and a draft that silently lives somewhere other than where the user
expects is worse than no draft feature.

## If we ever want a real draft object

Only worth doing if users ask to keep posts in progress across sessions, which is a content-calendar
feature and a much larger scope than this question. It would be an opencompany-owned draft, reviewed
in chat and published through `create_posts` on approval. Scheduling would need the same treatment:
X API v2 has no scheduling either, so a scheduled post means our own queue and runner, and the
`POST /12/accounts/:account_id/scheduled_tweets` Ads endpoint carries all the same access constraints
as its draft sibling.

## Non-goals

- No Ads API integration to get draft posts. The access, the ads account requirement, and the
  Promoted-only default make it the wrong object for a founder's personal account.
- No use of X's internal GraphQL API.
- No UI copy that claims we saved a draft to X.

## Current repo note

The connected X account surface is `packages/agent/src/integrations/x-api-tools.ts`, exposed through
`packages/agent/src/integrations/x-mcp-catalog.ts` with `read`, `query`, and `write` capabilities.
There is no `draft` capability for X, unlike Gmail's `create_draft` in
`packages/agent/src/integrations/gmail-mcp-server.ts`, and that difference is correct: Gmail has a
drafts API and X does not.
