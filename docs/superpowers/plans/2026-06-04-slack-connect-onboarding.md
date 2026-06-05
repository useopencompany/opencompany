# Slack Connect after onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer finishes onboarding for the first time, automatically provision a private Slack Connect channel shared with the OC support team, email them the join link, and surface a "Join our Slack" card (with a book-a-call fallback) in the app.

**Architecture:** `completeOnboarding` fires a fire-and-forget Inngest event on first onboarding. An Inngest function provisions the channel via a single Slack-SDK wrapper module, persists one row per workspace in `workspace_slack_channels` (unique `workspaceId` + `active` short-circuit = idempotent), then dispatches a Resend email. A server-rendered card reads that row and shows `active` / `pending` / `failed` states, never a dead button.

**Tech Stack:** Next.js (App Router, server actions), Drizzle ORM + Postgres, Inngest, Resend, `@slack/web-api`, vitest, Biome + ESLint, bun monorepo.

---

## Spec resolution — open questions answered against the code

Resolved during planning against the real repo (commit `2596e36`):

1. **Workspace slug source** → **slugify `workspaces.name`.** There is **no** slug column on `workspaces` (`packages/db/src/schema.ts:99` has only `id`, `workosOrganizationId`, `name`, `createdByUserId`, `teamSize`, `companyUrl`, timestamps). We derive a Slack-safe slug from `name`, prefix `oc-`, and on `name_taken` append a short id suffix.
2. **Re-onboarding re-trigger?** → **First-onboarding only.** `completeOnboarding` already gates first-time work behind `if (scaffold.created)` (`apps/web/lib/onboarding/actions.ts:138`). We dispatch the Slack event inside that branch. The `workspaceId` unique constraint + `active` short-circuit make a double-dispatch harmless regardless.
3. **Slack app review for `conversations.connect:write`** → **External / operational, not a code question.** Dev/sandbox works without review (we build + QA against a sandbox app). Production enablement (Phase 2) may require Slack app review; flagged as a rollout prerequisite, does not block Phase 1.

**Extra finding that needs a decision (UI placement):** The spec assumes an "onboarding-complete view" that renders *after* provisioning. In reality `completeOnboarding` **redirects first-timers to `/session/<id>`** (`actions.ts:184`) and re-submitters to `/` (`actions.ts:195`). The Cal.com booking lives on the *pre-submit* call step inside `OnboardingForm.tsx` — the channel does not exist yet there. So there is no natural post-provision view. **This plan mounts the card on the workspace home `apps/web/app/(workspace)/page.tsx`** (the surface returning users land on). The email is the primary delivery; the card is secondary. Confirm this placement before Task 8 (alternatives: session view, a dedicated `/onboarding/complete` route, or email-only for v1).

**Convention notes locked in:**
- IDs are app-generated, prefixed: `wks_${randomUUID()}` (`apps/web/lib/auth.ts:46`). New table uses `text` PK `wsc_${randomUUID()}`, **not** a uuid DB default (no table in this repo uses `defaultRandom`).
- Status is stored as `text` with a TS union `$type<...>()` (mirrors `agents.githubSyncStatus`), **not** a new `pgEnum`.
- Email idempotency is via Resend's `idempotencyKey` option (`signup-welcome.ts:286`), not Inngest config.
- Inngest functions use `triggers: { event }` (plural) + `concurrency` (`functions.ts:485`) and are registered in the `inngestFunctions` array (`functions.ts:502`).
- `completeOnboarding`'s `user` is an `AppUser` and **has `user.email`** (notNull on `users`, `schema.ts:75`) + `firstName`/`lastName` — the customer email source.
- All Slack SDK calls live behind `apps/web/lib/slack/support-client.ts`; nothing else imports `@slack/web-api`.

---

## File structure

**Create:**
- `apps/web/lib/slack/slugify.ts` — pure slug + channel-name helpers
- `apps/web/lib/slack/slugify.test.ts`
- `apps/web/lib/slack/support-client.ts` — the only `@slack/web-api` consumer
- `apps/web/lib/slack/support-client.test.ts`
- `apps/web/lib/slack/events.ts` — Inngest event name + dispatch helper for provisioning
- `apps/web/lib/email/slack-invite.ts` — render + send the invite email (mirrors `signup-welcome.ts`)
- `apps/web/lib/email/slack-invite.test.ts`
- `apps/web/lib/slack/data.ts` — `getWorkspaceSlackChannel(workspaceId)` read helper for the UI
- `apps/web/components/SlackSupportCard.tsx` — server component, 3 states
- `apps/web/lib/inngest/provision-slack-support.test.ts` — Inngest fn unit test

**Modify:**
- `apps/web/package.json` — add `@slack/web-api`
- `.env.example` + `docs/env-vars.md` — three new env vars
- `packages/db/src/schema.ts` — `workspaceSlackChannels` table + `SlackChannelStatus` type
- `drizzle/*` — generated migration (via `db:generate`)
- `apps/web/lib/email/events.ts` — `email.slack_invite_requested` event + dispatch helper
- `apps/web/lib/inngest/functions.ts` — `provisionSlackSupportChannel` + `sendSlackInvite` fns, registered in `inngestFunctions`
- `apps/web/lib/onboarding/actions.ts` — dispatch `slack.support_channel_requested` in the `scaffold.created` branch
- `apps/web/app/(workspace)/page.tsx` — mount `<SlackSupportCard>` (pending placement confirmation)

---

## Task 1: Dependency + env config (setup — delegable)

**Files:**
- Modify: `apps/web/package.json`
- Modify: `.env.example`
- Modify: `docs/env-vars.md`

- [ ] **Step 1: Add the Slack SDK to the web app**

```bash
cd apps/web && bun add @slack/web-api && cd ../..
```

- [ ] **Step 2: Add env vars to `.env.example`** (below the existing `SLACK_MCP_*` block, ~line 62)

```bash
# OC support Slack app (Slack Connect provisioning after onboarding).
# Distinct from SLACK_MCP_* (that is read-only agent OAuth against the customer's Slack).
SLACK_SUPPORT_BOT_TOKEN=""        # xoxb-… OC support app bot token (server-only, never NEXT_PUBLIC)
SLACK_SUPPORT_TEAM_ID=""          # OC Slack workspace/team id (T…)
SLACK_SUPPORT_MEMBER_IDS=""       # comma-separated U… ids of OC support members to invite
```

- [ ] **Step 3: Document the vars in `docs/env-vars.md`** — add a "Slack support (onboarding Slack Connect)" row group mirroring the `SLACK_MCP_*` entries, noting all three are server-only and the feature no-ops when `SLACK_SUPPORT_BOT_TOKEN` is empty.

- [ ] **Step 4: Verify install**

Run: `cd apps/web && bun pm ls | grep @slack/web-api`
Expected: prints a `@slack/web-api` version line.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json bun.lock .env.example docs/env-vars.md
git commit -m "chore: add Slack support SDK + env vars for Slack Connect onboarding"
```

---

## Task 2: `workspace_slack_channels` table + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create (generated): `drizzle/<NNNN>_*.sql`

- [ ] **Step 1: Add the table + status type** (append near the other workspace tables, after `onboardingResponses`, before the relations block)

```ts
export type SlackChannelStatus = "pending" | "active" | "failed";

export const workspaceSlackChannels = pgTable(
  "workspace_slack_channels",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackChannelId: text("slack_channel_id"),
    slackTeamId: text("slack_team_id"),
    inviteUrl: text("invite_url"),
    status: text("status").$type<SlackChannelStatus>().notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: uniqueIndex("workspace_slack_channels_workspace_idx").on(table.workspaceId),
  }),
);
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new `drizzle/<NNNN>_*.sql` creating `workspace_slack_channels` with the unique index. Inspect it: it must contain `CREATE TABLE "workspace_slack_channels"` and `CREATE UNIQUE INDEX "workspace_slack_channels_workspace_idx"` and **no unrelated schema changes** (per the schema-drift convention).

- [ ] **Step 3: Apply to the dev DB**

Run: `bun run db:migrate`
Expected: migration applies cleanly (authed pages would crash on QA otherwise).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts drizzle
git commit -m "feat(db): add workspace_slack_channels table"
```

---

## Task 3: Slug + channel-name helpers (pure, TDD)

**Files:**
- Create: `apps/web/lib/slack/slugify.ts`
- Test: `apps/web/lib/slack/slugify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { channelName, workspaceChannelSlug } from "./slugify";

describe("workspaceChannelSlug", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(workspaceChannelSlug("Acme Corp")).toBe("acme-corp");
  });
  it("strips symbols and collapses repeats", () => {
    expect(workspaceChannelSlug("Foo & Bar!!  Baz")).toBe("foo-bar-baz");
  });
  it("strips diacritics", () => {
    expect(workspaceChannelSlug("Café Déjà")).toBe("cafe-deja");
  });
  it("trims leading/trailing hyphens", () => {
    expect(workspaceChannelSlug("  --hi--  ")).toBe("hi");
  });
  it("caps length at 72 chars", () => {
    expect(workspaceChannelSlug("a".repeat(100)).length).toBe(72);
  });
  it("returns empty string for non-latin-only input", () => {
    expect(workspaceChannelSlug("日本語")).toBe("");
  });
});

describe("channelName", () => {
  it("prefixes oc- and falls back to team for empty slug", () => {
    expect(channelName("")).toBe("oc-team");
    expect(channelName("acme-corp")).toBe("oc-acme-corp");
  });
  it("appends a suffix when given", () => {
    expect(channelName("acme-corp", "a1b2c3")).toBe("oc-acme-corp-a1b2c3");
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `cd apps/web && bunx vitest run lib/slack/slugify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// Slack channel names: lowercase, only a-z0-9, hyphens/underscores, <= 80 chars.
// We reserve room for the "oc-" prefix + an optional "-<6 char>" collision suffix.
const MAX_SLUG_LEN = 72;

export function workspaceChannelSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LEN);
}

export function channelName(slug: string, suffix?: string): string {
  const safe = slug || "team";
  return suffix ? `oc-${safe}-${suffix}` : `oc-${safe}`;
}
```

- [ ] **Step 4: Run it to confirm pass**

Run: `cd apps/web && bunx vitest run lib/slack/slugify.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/slack/slugify.ts apps/web/lib/slack/slugify.test.ts
git commit -m "feat(slack): add workspace channel slug helpers"
```

---

## Task 4: Slack support client (TDD, mocked SDK)

**Files:**
- Create: `apps/web/lib/slack/support-client.ts`
- Test: `apps/web/lib/slack/support-client.test.ts`

> **CHECKPOINT — first real code task.** Per Jasper's workflow rule, pause here after the task is green and hand it to him to run/test/commit before continuing on autopilot.

- [ ] **Step 1: Write the failing test** (mock a `WebClient` shape; inject via `deps.client`)

```ts
import { describe, expect, it, vi } from "vitest";
import { provisionSupportChannel, SlackNotConfiguredError } from "./support-client";

function makeClient(overrides = {}) {
  return {
    conversations: {
      create: vi.fn().mockResolvedValue({ ok: true, channel: { id: "C123" } }),
      invite: vi.fn().mockResolvedValue({ ok: true }),
      inviteShared: vi.fn().mockResolvedValue({ ok: true, url: "https://join.slack.com/x" }),
    },
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
    ...overrides,
  } as never;
}

const workspace = { id: "wks_aaaaaaaa", name: "Acme Corp" };

describe("provisionSupportChannel", () => {
  it("creates a private channel, invites the team, sends a shared invite, posts intro", async () => {
    process.env.SLACK_SUPPORT_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SUPPORT_TEAM_ID = "T1";
    process.env.SLACK_SUPPORT_MEMBER_IDS = "U1, U2";
    const client = makeClient();

    const result = await provisionSupportChannel(
      { workspace, customerEmail: "c@acme.com" },
      { client },
    );

    expect(client.conversations.create).toHaveBeenCalledWith({
      name: "oc-acme-corp",
      is_private: true,
    });
    expect(client.conversations.invite).toHaveBeenCalledWith({ channel: "C123", users: "U1,U2" });
    expect(client.conversations.inviteShared).toHaveBeenCalledWith({
      channel: "C123",
      emails: ["c@acme.com"],
    });
    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(result).toEqual({ channelId: "C123", teamId: "T1", inviteUrl: "https://join.slack.com/x" });
  });

  it("retries with a suffix on name_taken", async () => {
    process.env.SLACK_SUPPORT_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SUPPORT_MEMBER_IDS = "";
    const client = makeClient();
    client.conversations.create
      .mockRejectedValueOnce({ data: { error: "name_taken" } })
      .mockResolvedValueOnce({ ok: true, channel: { id: "C999" } });

    const result = await provisionSupportChannel(
      { workspace, customerEmail: "c@acme.com" },
      { client },
    );

    expect(client.conversations.create).toHaveBeenCalledTimes(2);
    expect(client.conversations.invite).not.toHaveBeenCalled(); // no member ids
    expect(result.channelId).toBe("C999");
  });

  it("throws SlackNotConfiguredError when the token is missing", async () => {
    process.env.SLACK_SUPPORT_BOT_TOKEN = "";
    await expect(
      provisionSupportChannel({ workspace, customerEmail: "c@acme.com" }, { client: makeClient() }),
    ).rejects.toBeInstanceOf(SlackNotConfiguredError);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `cd apps/web && bunx vitest run lib/slack/support-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { WebClient } from "@slack/web-api";
import { channelName, workspaceChannelSlug } from "./slugify";

export type ProvisionInput = {
  workspace: { id: string; name: string };
  customerEmail: string;
};
export type ProvisionResult = {
  channelId: string;
  teamId: string | null;
  inviteUrl: string | null;
};

export class SlackNotConfiguredError extends Error {
  constructor(message = "Slack support bot token is not configured") {
    super(message);
    this.name = "SlackNotConfiguredError";
  }
}
export class SlackProvisionError extends Error {
  slackError?: string;
  constructor(message: string, slackError?: string) {
    super(message);
    this.name = "SlackProvisionError";
    this.slackError = slackError;
  }
}

type SlackLike = Pick<WebClient, "conversations" | "chat">;

function getConfig() {
  return {
    token: process.env.SLACK_SUPPORT_BOT_TOKEN?.trim() ?? "",
    teamId: process.env.SLACK_SUPPORT_TEAM_ID?.trim() || null,
    memberIds: (process.env.SLACK_SUPPORT_MEMBER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

export function isSlackSupportConfigured(): boolean {
  return getConfig().token.length > 0;
}

function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } } | undefined)?.data?.error;
}

export async function provisionSupportChannel(
  input: ProvisionInput,
  deps?: { client?: SlackLike },
): Promise<ProvisionResult> {
  const { token, teamId, memberIds } = getConfig();
  if (!token) throw new SlackNotConfiguredError();
  const client = deps?.client ?? (new WebClient(token) as SlackLike);

  const slug = workspaceChannelSlug(input.workspace.name);

  let channelId: string | undefined;
  try {
    const created = await client.conversations.create({
      name: channelName(slug),
      is_private: true,
    });
    channelId = created.channel?.id;
  } catch (error) {
    if (slackErrorCode(error) !== "name_taken") {
      throw new SlackProvisionError("conversations.create failed", slackErrorCode(error));
    }
    const suffix = input.workspace.id.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase();
    const retry = await client.conversations.create({
      name: channelName(slug, suffix),
      is_private: true,
    });
    channelId = retry.channel?.id;
  }
  if (!channelId) throw new SlackProvisionError("conversations.create returned no channel id");

  if (memberIds.length > 0) {
    await client.conversations.invite({ channel: channelId, users: memberIds.join(",") });
  }

  const shared = await client.conversations.inviteShared({
    channel: channelId,
    emails: [input.customerEmail],
  });
  const inviteUrl = (shared as { url?: string }).url ?? null;

  await client.chat.postMessage({
    channel: channelId,
    text: "👋 This is your private support channel with OpenCompany. Ask us anything here — we read it in real time.",
  });

  return { channelId, teamId, inviteUrl };
}
```

> **Note for implementer:** confirm the `conversations.inviteShared` response field name (`url`) against the sandbox response during Task 9 QA; the SDK types it loosely. The test pins our contract.

- [ ] **Step 4: Run it to confirm pass**

Run: `cd apps/web && bunx vitest run lib/slack/support-client.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/slack/support-client.ts apps/web/lib/slack/support-client.test.ts
git commit -m "feat(slack): add support-channel provisioning client"
```

---

## Task 5: Slack invite email (TDD, mirrors signup-welcome)

**Files:**
- Modify: `apps/web/lib/email/events.ts`
- Create: `apps/web/lib/email/slack-invite.ts`
- Test: `apps/web/lib/email/slack-invite.test.ts`

- [ ] **Step 1: Add the event + dispatch helper to `events.ts`**

```ts
export const SLACK_INVITE_EMAIL_REQUESTED_EVENT = "email.slack_invite_requested";

export type SlackInviteEmailRequestedEventData = {
  userId: string;
  workspaceId: string;
  email: string;
  firstName?: string | null;
  inviteUrl: string;
};

export function dispatchSlackInviteEmailRequested(input: SlackInviteEmailRequestedEventData) {
  return inngest.send({ name: SLACK_INVITE_EMAIL_REQUESTED_EVENT, data: input });
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { renderSlackInviteEmail, sendSlackInviteEmail } from "./slack-invite";

describe("renderSlackInviteEmail", () => {
  it("greets by first name and links the invite url", () => {
    const out = renderSlackInviteEmail({ firstName: "Sam", inviteUrl: "https://join.slack.com/x" });
    expect(out.html).toContain("Hi Sam,");
    expect(out.html).toContain('href="https://join.slack.com/x"');
    expect(out.text).toContain("https://join.slack.com/x");
  });
  it("falls back to 'there' with no name", () => {
    expect(renderSlackInviteEmail({ inviteUrl: "https://x" }).html).toContain("Hi there,");
  });
});

describe("sendSlackInviteEmail", () => {
  const base = { userId: "u1", workspaceId: "w1", email: "c@acme.com", firstName: "Sam" };

  it("skips when inviteUrl is empty", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_REGISTERED_USERS_SEGMENT_ID = "seg_1";
    const result = await sendSlackInviteEmail({ ...base, inviteUrl: "" });
    expect(result.status).toBe("skipped");
  });

  it("sends with idempotency key slack-invite:<workspaceId>", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_REGISTERED_USERS_SEGMENT_ID = "seg_1";
    const send = vi.fn().mockResolvedValue({ data: { id: "email_1" }, error: null });
    const client = { emails: { send } } as never;
    const result = await sendSlackInviteEmail(
      { ...base, inviteUrl: "https://join.slack.com/x" },
      { client },
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "c@acme.com" }),
      { idempotencyKey: "slack-invite:w1" },
    );
    expect(result.status).toBe("sent");
  });

  it("skips when Resend is not configured", async () => {
    process.env.RESEND_API_KEY = "";
    const result = await sendSlackInviteEmail({ ...base, inviteUrl: "https://x" });
    expect(result.status).toBe("skipped");
  });
});
```

- [ ] **Step 3: Run it to confirm failure**

Run: `cd apps/web && bunx vitest run lib/email/slack-invite.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** (slimmer than signup-welcome — no contact/segment sync, just send)

```ts
import { captureException, createLogger } from "@opencompany/observability";
import { Resend, type Response as ResendResponse } from "resend";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

const DEFAULT_FROM = "Louis from OpenCompany <louis@opencompany.cloud>";
const DEFAULT_REPLY_TO = "louis@opencompany.cloud";
const SUBJECT = "Your direct line to the OpenCompany team";

export type SlackInviteEmailInput = {
  userId: string;
  workspaceId: string;
  email: string;
  firstName?: string | null;
  inviteUrl: string;
};

type ResendEmailClient = {
  emails: {
    send: (
      payload: {
        from: string;
        to: string;
        subject: string;
        html: string;
        text: string;
        replyTo: string;
        tags: Array<{ name: string; value: string }>;
      },
      options: { idempotencyKey: string },
    ) => Promise<ResendResponse<{ id: string }>>;
  };
};

let resendClient: ResendEmailClient | null = null;

function trimmed(value: string | undefined) {
  const next = value?.trim();
  return next || undefined;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderSlackInviteEmail(input: { firstName?: string | null; inviteUrl: string }) {
  const greetingName = trimmed(input.firstName ?? undefined) ?? "there";
  const greeting = `Hi ${greetingName},`;
  const url = input.inviteUrl;

  const text = [
    greeting,
    "",
    "We just opened a private Slack channel between your team and ours — your direct line to the OpenCompany team.",
    "",
    `Join here: ${url}`,
    "",
    "You can ask us anything there and we'll answer in real time.",
    "",
    "Louis",
  ].join("\n");

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<body>",
    `<p>${escapeHtml(greeting)}</p>`,
    "<p>We just opened a private Slack channel between your team and ours — your direct line to the OpenCompany team.</p>",
    `<p><a href="${escapeHtml(url)}">Join our Slack</a></p>`,
    "<p>You can ask us anything there and we'll answer in real time.</p>",
    "<p>Louis</p>",
    "</body>",
    "</html>",
  ].join("");

  return { subject: SUBJECT, text, html };
}

function getConfig() {
  const apiKey = trimmed(process.env.RESEND_API_KEY);
  if (!apiKey) return { enabled: false as const, reason: "missing_api_key" as const };
  return {
    enabled: true as const,
    apiKey,
    from: trimmed(process.env.RESEND_WELCOME_FROM) ?? DEFAULT_FROM,
    replyTo: trimmed(process.env.RESEND_REPLY_TO) ?? DEFAULT_REPLY_TO,
  };
}

function getResendClient(apiKey: string): ResendEmailClient {
  resendClient ??= new Resend(apiKey) as unknown as ResendEmailClient;
  return resendClient;
}

export async function sendSlackInviteEmail(
  input: SlackInviteEmailInput,
  options?: { client?: ResendEmailClient },
) {
  if (!trimmed(input.inviteUrl)) {
    logger.info("Skipped Slack invite email — no invite url", {
      event: "opencompany.slack_invite_email_skipped",
      workspace_id: input.workspaceId,
      reason: "no_invite_url",
    });
    return { status: "skipped", reason: "no_invite_url" } as const;
  }

  const config = getConfig();
  if (!config.enabled) {
    logger.info("Skipped Slack invite email — Resend not configured", {
      event: "opencompany.slack_invite_email_skipped",
      workspace_id: input.workspaceId,
      reason: config.reason,
    });
    return { status: "skipped", reason: config.reason } as const;
  }

  const client = options?.client ?? getResendClient(config.apiKey);
  const rendered = renderSlackInviteEmail({ firstName: input.firstName, inviteUrl: input.inviteUrl });

  try {
    const response = await client.emails.send(
      {
        from: config.from,
        to: input.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        replyTo: config.replyTo,
        tags: [
          { name: "category", value: "transactional" },
          { name: "type", value: "slack_invite" },
        ],
      },
      { idempotencyKey: `slack-invite:${input.workspaceId}` },
    );
    if (response.error) throw new Error(`Unable to send Slack invite email: ${response.error.message}`);

    logger.info("Sent Slack invite email", {
      event: "opencompany.slack_invite_email_sent",
      workspace_id: input.workspaceId,
      email_id: response.data?.id,
    });
    return { status: "sent", emailId: response.data?.id } as const;
  } catch (error) {
    captureException(error, {
      event: "opencompany.slack_invite_email_failed",
      workspace_id: input.workspaceId,
    });
    throw error;
  }
}
```

- [ ] **Step 5: Run it to confirm pass**

Run: `cd apps/web && bunx vitest run lib/email/slack-invite.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/email/events.ts apps/web/lib/email/slack-invite.ts apps/web/lib/email/slack-invite.test.ts
git commit -m "feat(email): add Slack invite email"
```

---

## Task 6: Inngest provisioning + email functions

**Files:**
- Create: `apps/web/lib/slack/events.ts`
- Modify: `apps/web/lib/inngest/functions.ts`
- Test: `apps/web/lib/inngest/provision-slack-support.test.ts`

- [ ] **Step 1: Add the provisioning event to `apps/web/lib/slack/events.ts`**

```ts
import { inngest } from "@/lib/inngest/client";

export const SLACK_SUPPORT_CHANNEL_REQUESTED_EVENT = "slack.support_channel_requested";

export type SlackSupportChannelRequestedEventData = {
  workspaceId: string;
  userId: string;
  customerEmail: string;
  firstName?: string | null;
};

export function dispatchSlackSupportChannelRequested(
  input: SlackSupportChannelRequestedEventData,
) {
  return inngest.send({ name: SLACK_SUPPORT_CHANNEL_REQUESTED_EVENT, data: input });
}
```

- [ ] **Step 2: Write the failing Inngest unit test** (drive the handler with a fake `step` + mocked deps; assert DB row transitions + short-circuit + no-op)

```ts
import { describe, expect, it, vi } from "vitest";

const provisionSupportChannel = vi.fn();
const isSlackSupportConfigured = vi.fn();
const sendSlackInviteEmail = vi.fn();

vi.mock("@/lib/slack/support-client", () => ({
  provisionSupportChannel,
  isSlackSupportConfigured,
  SlackNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email/slack-invite", () => ({ sendSlackInviteEmail }));

// In-memory stand-in for the workspace_slack_channels row.
let row: { status: string; inviteUrl: string | null; error: string | null } | null;
const upsertPending = vi.fn(async () => {
  row ??= { status: "pending", inviteUrl: null, error: null };
  return row;
});
const markActive = vi.fn(async (data) => {
  row = { status: "active", inviteUrl: data.inviteUrl, error: null };
});
const markFailed = vi.fn(async (error: string) => {
  row = { status: "failed", inviteUrl: null, error };
});
const getRow = vi.fn(async () => row);
vi.mock("@/lib/slack/data", () => ({ upsertPending, markActive, markFailed, getWorkspaceSlackChannel: getRow }));

import { runProvisionSlackSupport } from "@/lib/inngest/provision-slack-support";

function fakeStep() {
  return { run: async (_label: string, fn: () => unknown) => fn() } as never;
}
const event = {
  data: { workspaceId: "w1", userId: "u1", customerEmail: "c@acme.com", firstName: "Sam" },
} as never;

describe("runProvisionSlackSupport", () => {
  beforeEach(() => {
    row = null;
    vi.clearAllMocks();
    isSlackSupportConfigured.mockReturnValue(true);
  });

  it("provisions, marks active, dispatches email", async () => {
    provisionSupportChannel.mockResolvedValue({ channelId: "C1", teamId: "T1", inviteUrl: "https://x" });
    await runProvisionSlackSupport({ event, step: fakeStep(), workspace: { id: "w1", name: "Acme" } });
    expect(markActive).toHaveBeenCalled();
    expect(sendSlackInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ inviteUrl: "https://x" }));
  });

  it("short-circuits when row is already active (no second channel)", async () => {
    row = { status: "active", inviteUrl: "https://x", error: null };
    await runProvisionSlackSupport({ event, step: fakeStep(), workspace: { id: "w1", name: "Acme" } });
    expect(provisionSupportChannel).not.toHaveBeenCalled();
  });

  it("no-ops to failed when Slack is not configured (does not throw)", async () => {
    isSlackSupportConfigured.mockReturnValue(false);
    await expect(
      runProvisionSlackSupport({ event, step: fakeStep(), workspace: { id: "w1", name: "Acme" } }),
    ).resolves.not.toThrow();
    expect(markFailed).toHaveBeenCalled();
    expect(sendSlackInviteEmail).not.toHaveBeenCalled();
  });

  it("marks failed and rethrows on Slack error (so Inngest retries)", async () => {
    provisionSupportChannel.mockRejectedValue(new Error("slack boom"));
    await expect(
      runProvisionSlackSupport({ event, step: fakeStep(), workspace: { id: "w1", name: "Acme" } }),
    ).rejects.toThrow("slack boom");
    expect(markFailed).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Add the data helpers `apps/web/lib/slack/data.ts`** (so the fn + UI share one read/write seam)

```ts
import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { type SlackChannelStatus, workspaceSlackChannels } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";

export type WorkspaceSlackChannel = {
  status: SlackChannelStatus;
  inviteUrl: string | null;
  slackChannelId: string | null;
  error: string | null;
};

export async function getWorkspaceSlackChannel(
  workspaceId: string,
): Promise<WorkspaceSlackChannel | null> {
  const db = getDb();
  const [found] = await db
    .select({
      status: workspaceSlackChannels.status,
      inviteUrl: workspaceSlackChannels.inviteUrl,
      slackChannelId: workspaceSlackChannels.slackChannelId,
      error: workspaceSlackChannels.error,
    })
    .from(workspaceSlackChannels)
    .where(eq(workspaceSlackChannels.workspaceId, workspaceId))
    .limit(1);
  return found ?? null;
}

export async function upsertPending(workspaceId: string): Promise<WorkspaceSlackChannel> {
  const db = getDb();
  await db
    .insert(workspaceSlackChannels)
    .values({ id: `wsc_${randomUUID()}`, workspaceId, status: "pending" })
    .onConflictDoNothing({ target: workspaceSlackChannels.workspaceId });
  const row = await getWorkspaceSlackChannel(workspaceId);
  if (!row) throw new Error("Failed to upsert workspace_slack_channels row");
  return row;
}

export async function markActive(input: {
  workspaceId: string;
  slackChannelId: string;
  slackTeamId: string | null;
  inviteUrl: string | null;
}) {
  const db = getDb();
  await db
    .update(workspaceSlackChannels)
    .set({
      status: "active",
      slackChannelId: input.slackChannelId,
      slackTeamId: input.slackTeamId,
      inviteUrl: input.inviteUrl,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaceSlackChannels.workspaceId, input.workspaceId));
}

export async function markFailed(workspaceId: string, error: string) {
  const db = getDb();
  await db
    .update(workspaceSlackChannels)
    .set({ status: "failed", error: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(workspaceSlackChannels.workspaceId, workspaceId));
}
```

- [ ] **Step 4: Add the handler `apps/web/lib/slack/provision-slack-support.ts`** wait — keep the handler in `apps/web/lib/inngest/provision-slack-support.ts` (test imports it from there). It loads the workspace, runs the steps, and is wrapped by the Inngest fn in `functions.ts`.

```ts
import { getDb } from "@opencompany/db/client";
import { workspaces } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import { sendSlackInviteEmail } from "@/lib/email/slack-invite";
import {
  getWorkspaceSlackChannel,
  markActive,
  markFailed,
  upsertPending,
} from "@/lib/slack/data";
import { isSlackSupportConfigured, provisionSupportChannel } from "@/lib/slack/support-client";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

type StepLike = { run: <T>(label: string, fn: () => Promise<T> | T) => Promise<T> };
type EventLike = {
  data: { workspaceId: string; userId: string; customerEmail: string; firstName?: string | null };
};

export async function runProvisionSlackSupport(args: {
  event: EventLike;
  step: StepLike;
  // optional injected workspace for tests; loaded from DB in production
  workspace?: { id: string; name: string };
}) {
  const { event, step } = args;
  const { workspaceId, userId, customerEmail, firstName } = event.data;

  const existing = await step.run("ensure-row", async () => upsertPending(workspaceId));
  if (existing.status === "active") {
    logger.info("Slack support channel already active — short-circuit", {
      event: "opencompany.slack_support_channel_short_circuit",
      workspace_id: workspaceId,
    });
    return { status: "active", short_circuited: true };
  }

  if (!isSlackSupportConfigured()) {
    await step.run("mark-not-configured", async () =>
      markFailed(workspaceId, "SLACK_SUPPORT_BOT_TOKEN not configured"),
    );
    logger.warn("Slack support not configured — feature off", {
      event: "opencompany.slack_support_not_configured",
      workspace_id: workspaceId,
    });
    return { status: "failed", reason: "not_configured" };
  }

  const workspace =
    args.workspace ??
    (await step.run("load-workspace", async () => {
      const db = getDb();
      const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
      return ws;
    }));

  let inviteUrl: string | null = null;
  try {
    const result = await step.run("provision", async () =>
      provisionSupportChannel({ workspace, customerEmail }),
    );
    inviteUrl = result.inviteUrl;
    await step.run("mark-active", async () =>
      markActive({
        workspaceId,
        slackChannelId: result.channelId,
        slackTeamId: result.teamId,
        inviteUrl: result.inviteUrl,
      }),
    );
  } catch (error) {
    await step.run("mark-failed", async () =>
      markFailed(workspaceId, error instanceof Error ? error.message : "Unknown Slack error"),
    );
    captureException(error, {
      event: "opencompany.slack_support_provision_failed",
      workspace_id: workspaceId,
    });
    throw error; // let Inngest retry transient failures
  }

  await step.run("dispatch-email", async () => {
    const row = await getWorkspaceSlackChannel(workspaceId);
    if (row?.status !== "active" || !row.inviteUrl) return { dispatched: false };
    await sendSlackInviteEmail({ userId, workspaceId, email: customerEmail, firstName, inviteUrl: row.inviteUrl });
    return { dispatched: true };
  });

  return { status: "active", inviteUrl };
}
```

- [ ] **Step 5: Register the Inngest fn in `functions.ts`** — import the event + handler, wrap, append to `inngestFunctions`.

```ts
// add to imports
import { SLACK_SUPPORT_CHANNEL_REQUESTED_EVENT } from "@/lib/slack/events";
import { runProvisionSlackSupport } from "@/lib/inngest/provision-slack-support";

export const provisionSlackSupportChannel = inngest.createFunction(
  {
    id: "provision-slack-support-channel",
    name: "Provision Slack support channel",
    retries: 3,
    idempotency: "event.data.workspaceId",
    concurrency: { limit: 1, key: "event.data.workspaceId" },
    triggers: { event: SLACK_SUPPORT_CHANNEL_REQUESTED_EVENT },
  },
  async ({ event, step }) => runProvisionSlackSupport({ event, step }),
);
```

Append `provisionSlackSupportChannel` to the `inngestFunctions` array.

- [ ] **Step 6: Run the test**

Run: `cd apps/web && bunx vitest run lib/inngest/provision-slack-support.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/slack/events.ts apps/web/lib/slack/data.ts apps/web/lib/inngest/provision-slack-support.ts apps/web/lib/inngest/provision-slack-support.test.ts apps/web/lib/inngest/functions.ts
git commit -m "feat(slack): add Inngest provisioning function + persistence"
```

---

## Task 7: Dispatch from `completeOnboarding` (first onboarding only)

**Files:**
- Modify: `apps/web/lib/onboarding/actions.ts`

- [ ] **Step 1: Add the dispatch inside the `if (scaffold.created)` branch**, before `startSeededAgentSession` (must run before any `redirect()`), fire-and-forget with try/catch so Slack never blocks or crashes onboarding.

```ts
// imports
import { dispatchSlackSupportChannelRequested } from "@/lib/slack/events";
```

```ts
  if (scaffold.created) {
    try {
      await dispatchSlackSupportChannelRequested({
        workspaceId: workspace.id,
        userId: user.id,
        customerEmail: user.email,
        firstName: user.firstName,
      });
    } catch (error) {
      captureException(error, {
        event: "opencompany.slack_support_dispatch_failed",
        workspace_id: workspace.id,
        user_id: user.id,
      });
      logger.error("Failed to dispatch Slack support provisioning", {
        event: "opencompany.slack_support_dispatch_failed",
        workspace_id: workspace.id,
        user_id: user.id,
        ...errorLogFields(error),
      });
    }

    let sessionId: string | null = null;
    // ...existing startSeededAgentSession block unchanged...
```

> `user.firstName` is on `AppUser` (`schema.ts:76`); if the type doesn't expose it at this call site, fall back to `null`.

- [ ] **Step 2: Type-check the action**

Run: `cd apps/web && bunx tsc --noEmit` (or rely on `bun run lint` in the final task)
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/onboarding/actions.ts
git commit -m "feat(onboarding): dispatch Slack support provisioning on first onboarding"
```

---

## Task 8: Onboarding-complete card (server component) — **pending placement confirmation**

**Files:**
- Create: `apps/web/components/SlackSupportCard.tsx`
- Modify: `apps/web/app/(workspace)/page.tsx`

> Mounts on the workspace home (`/`). Confirm placement with Jasper before building (see "Extra finding" above). The booking link reuses the existing Cal.com link from `OnboardingForm.tsx:29`: `https://cal.com/team/opencompany/intro-call?overlayCalendar=true`.

- [ ] **Step 1: Build the card** (server component; never renders a dead Slack button)

```tsx
import { getWorkspaceSlackChannel } from "@/lib/slack/data";

const BOOK_CALL_URL = "https://cal.com/team/opencompany/intro-call?overlayCalendar=true";

export default async function SlackSupportCard({ workspaceId }: { workspaceId: string }) {
  const channel = await getWorkspaceSlackChannel(workspaceId);
  if (!channel) return null;

  if (channel.status === "active" && channel.inviteUrl) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-[14px] font-semibold text-ink">Direct line to the OC team</h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          We opened a private Slack channel between your team and ours.
        </p>
        <a
          href={channel.inviteUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex h-8 items-center rounded-md bg-ink px-3 text-[12px] font-medium text-canvas"
        >
          Join our Slack
        </a>
        <a href={BOOK_CALL_URL} target="_blank" rel="noreferrer" className="ml-3 text-[12px] text-ink-subtle hover:text-ink">
          No Slack? Book a call
        </a>
      </section>
    );
  }

  if (channel.status === "pending") {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-[14px] font-semibold text-ink">Setting up your Slack channel…</h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          We're opening your private support channel — the invite arrives by email shortly.
        </p>
        <a href={BOOK_CALL_URL} target="_blank" rel="noreferrer" className="mt-3 inline-block text-[12px] text-ink-subtle hover:text-ink">
          Prefer to talk? Book a call
        </a>
      </section>
    );
  }

  // failed / no invite → booking fallback only, never a broken Slack button
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-[14px] font-semibold text-ink">Need a hand getting started?</h2>
      <a href={BOOK_CALL_URL} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[12px] text-ink-subtle hover:text-ink">
        Book a call with the OC team
      </a>
    </section>
  );
}
```

- [ ] **Step 2: Mount it on the workspace home** — in `apps/web/app/(workspace)/page.tsx`, render the card above `<MainPanel>` (respecting the max-2-buttons rule: one real button + a quiet link). Adjust JSX to a fragment:

```tsx
  return (
    <>
      <SlackSupportCard workspaceId={context.workspace.id} />
      <MainPanel agents={rows} />
    </>
  );
```

(Add `import SlackSupportCard from "@/components/SlackSupportCard";`. If `MainPanel` owns the full-height layout, instead pass the card in as a prop/slot rather than a sibling — match the existing layout container so it doesn't break the panel.)

- [ ] **Step 3: Verify it renders in all three states** — covered by browser QA in Task 9 (active/pending/failed by seeding rows). No unit test for the JSX.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/SlackSupportCard.tsx "apps/web/app/(workspace)/page.tsx"
git commit -m "feat(onboarding): surface Slack support card with booking fallback"
```

---

## Task 9: Full verification + sandbox QA + draft PR

**Files:** none (verification + PR).

- [ ] **Step 1: Secret-leak check before any push**

Run: `git diff origin/main...HEAD | grep -i slack`
Expected: only env var **names** and code — **no `xoxb-` token value**, no `NEXT_PUBLIC_SLACK`, no token in any committed file.

- [ ] **Step 2: Run the full suite (not just changed files)** — new exports can break sibling suites.

```bash
bun run test
bun run lint
bunx biome check .
```

Expected: all three green.

- [ ] **Step 3: Confirm the migration is applied to the dev DB**

Run: `bun run db:migrate`
Expected: no pending migration (authed pages crash otherwise).

- [ ] **Step 4: Real browser QA against a Slack SANDBOX/dev app** (NEVER the real OC team Slack)
  - Set `SLACK_SUPPORT_BOT_TOKEN`/`TEAM_ID`/`MEMBER_IDS` to the sandbox app in `.env.local`.
  - Boot the dev server + the Inngest dev server so the function actually runs.
  - Complete onboarding as a fresh user → confirm: a private `#oc-<slug>` channel is created in the sandbox, the support member(s) are invited, the invite email arrives (or Resend dashboard shows it), and the workspace home shows the working **Join our Slack** card.
  - Seed `status='pending'` and `status='failed'` rows manually to screenshot those two card states (no dead button on failed).
  - Screenshots → PR body.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin spec/slack-connect
```

- [ ] **Step 6: Open a DRAFT PR (do not mark ready, do not merge)**

```bash
gh pr create --draft --title "[PRO-NN] Slack Connect after onboarding" --body "<summary + the three QA screenshots + Phase-2 Slack-review note>"
```

Then hand the PR URL to Jasper. **Do not run `gh pr ready` or `gh pr merge`.**

---

## Self-review (against the spec)

- **Data model** → Task 2 (unique `workspaceId`, status text). ✓
- **Slack client (create/invite/inviteShared/postMessage, name_taken fallback, typed errors, single seam)** → Task 4. ✓
- **Inngest trigger (concurrency by workspace, idempotency, ensure-row, active short-circuit, provision, dispatch-email, registered)** → Task 6. ✓
- **First-onboarding dispatch, fire-and-forget** → Task 7. ✓
- **Email (Louis sender, idempotency key, skip on no url)** → Task 5. ✓
- **UI card (active/pending/failed, Join button, booking fallback, max-2-buttons)** → Task 8 (placement pending confirmation). ✓
- **Missing-env no-op to failed (no crash)** → Task 6 Step 4 + test. ✓
- **Idempotency (unique + active short-circuit)** → Task 2 + Task 6. ✓
- **Security (server-only token, only inviteUrl to client, private channels)** → enforced in Task 4/8 + Task 9 leak check. ✓
- **Env config + docs** → Task 1. ✓
- **Testing (vitest unit, sandbox browser QA, screenshots)** → Tasks 3–6 + Task 9. ✓
- **Rollout phasing (sandbox first, prod app review later)** → Task 9 + Phase-2 note. ✓

**Open decision before coding:** UI placement (Task 8). Everything else is resolved against the code.
