import { resolveActionApproval } from "@opencompany/db/action-governance";
import { createTestPGlite } from "@opencompany/db/test-pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_EFFECTS_READ, type ResolvedAction } from "../actions/types";
import { registerReviewedApproval } from "./persisted-action-gateway";

let pg: Awaited<ReturnType<typeof createTestPGlite>>;
let db: ReturnType<typeof drizzle>;
const queryParameters: unknown[][] = [];
const run = {
  sessionId: "session",
  runId: "run",
  actorId: "user",
  workspaceId: "workspace",
  policy: "foregroundInteractive" as const,
};
const turn = {
  sessionId: "session",
  turnId: "run",
  userWorkosId: "user",
  workspaceId: "workspace",
  policy: "foregroundInteractive" as const,
};
const action: ResolvedAction = {
  id: "plugin:linear:linear.get_issue",
  provider: "plugin:linear:linear",
  capability: "read",
  description: "Get issue",
  effects: ACTION_EFFECTS_READ,
  permissionMode: "ask",
  params: {},
  execute: vi.fn(),
};
const input = {
  run,
  action,
  invocationId: "call",
  actionId: action.id,
  sourceId: action.provider,
  capabilityId: action.capability,
  params: { id: "ENG-1" },
  approvalContext: "connection-v1",
};
const review = vi.fn(async () => ({
  outcome: "auto_approved" as const,
  reason: "routine_action" as const,
  model: "typesafe-ai/jev",
  policy: "task-risk-v2",
  durationMs: 1,
}));
const capture = vi.fn(async () => {});
const deps = () => ({ db, review, capture });

beforeEach(async () => {
  vi.clearAllMocks();
  queryParameters.length = 0;
  pg = await createTestPGlite();
  db = drizzle(pg, { logger: { logQuery: (_query, params) => queryParameters.push(params) } });
  await pg.exec(`CREATE SCHEMA goat;
CREATE TABLE goat.users (workos_user_id text PRIMARY KEY, approve_for_me_enabled boolean);
CREATE TABLE goat.codex_chat_turns (id text PRIMARY KEY, user_workos_id text, codex_chat_session_id text, status text, interrupt_requested_at timestamptz, prompt text, created_at timestamptz DEFAULT now());
CREATE TABLE goat.action_turns (id text PRIMARY KEY, session_id text, turn_id text, user_workos_id text, workspace_id text, policy text,
 action_call_count integer DEFAULT 0, invocation_ids jsonb DEFAULT '[]', listed_source_ids jsonb DEFAULT '[]', quoted_total_usd_micros bigint DEFAULT 0,
 admitted_invocation_ids jsonb DEFAULT '[]', capability_quotes jsonb DEFAULT '{}', approval_records jsonb DEFAULT '{}', async_runs_started integer DEFAULT 0,
 async_invocation_ids jsonb DEFAULT '[]', expires_at timestamptz, created_at timestamptz, updated_at timestamptz, UNIQUE(session_id,turn_id));
INSERT INTO goat.users VALUES ('user',true);
INSERT INTO goat.codex_chat_turns VALUES ('run','user','session','running',NULL,'Summarize ENG-1', now());`);
});
afterEach(async () => {
  await pg.close();
});

describe("persisted automatic approval", () => {
  it("reviews once and keeps the exact approval on repeated checks", async () => {
    expect(await registerReviewedApproval(input, deps())).toMatchObject({
      status: "approved",
      automaticReview: { outcome: "auto_approved" },
    });
    expect(await registerReviewedApproval(input, deps())).toMatchObject({ status: "approved" });
    expect(review).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      "action_approval_reviewed",
      "user",
      expect.objectContaining({ outcome: "auto_approved", request_id: "call" }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain("Summarize ENG-1");
    expect(JSON.stringify(queryParameters)).not.toContain("Summarize ENG-1");
    expect(
      await registerReviewedApproval({ ...input, params: { id: "ENG-2" } }, deps()),
    ).toBeNull();
    expect(
      await registerReviewedApproval({ ...input, approvalContext: "connection-v2" }, deps()),
    ).toBeNull();
  });
  it("loads only earlier requests by this actor in this session", async () => {
    await pg.exec(`INSERT INTO goat.codex_chat_turns VALUES
      ('earlier','user','session','completed',NULL,'Find the Roadmap project',now()-interval '1 minute'),
      ('other-session','user','elsewhere','completed',NULL,'PRIVATE_OTHER_SESSION',now()-interval '1 minute'),
      ('other-user','other','session','completed',NULL,'PRIVATE_OTHER_USER',now()-interval '1 minute'),
      ('future','user','session','queued',NULL,'FUTURE_REQUEST',now()+interval '1 minute');`);
    await registerReviewedApproval(input, deps());
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ requestContext: ["Find the Roadmap project"] }),
    );
  });
  it("never revisits requests presented before opt-in or manual denials", async () => {
    await pg.exec("UPDATE goat.users SET approve_for_me_enabled=false");
    expect(await registerReviewedApproval(input, deps())).toMatchObject({ status: "pending" });
    await pg.exec("UPDATE goat.users SET approve_for_me_enabled=true");
    expect(await registerReviewedApproval(input, deps())).toMatchObject({ status: "pending" });
    await resolveActionApproval({ turn, invocationId: "call", decision: "denied", db });
    expect(await registerReviewedApproval(input, deps())).toMatchObject({ status: "denied" });
    expect(review).not.toHaveBeenCalled();
  });
  it("rechecks opt-out at decision commit and before execution", async () => {
    const disablingReview = async () => {
      await pg.exec("UPDATE goat.users SET approve_for_me_enabled=false");
      return review();
    };
    expect(
      await registerReviewedApproval(input, { ...deps(), review: disablingReview }),
    ).toMatchObject({ status: "pending" });
    expect(capture).not.toHaveBeenCalled();
    await pg.exec("UPDATE goat.users SET approve_for_me_enabled=true");
    expect(
      await registerReviewedApproval({ ...input, invocationId: "next" }, deps()),
    ).toMatchObject({ status: "approved" });
    await pg.exec("UPDATE goat.users SET approve_for_me_enabled=false");
    expect(
      await registerReviewedApproval({ ...input, invocationId: "next" }, deps()),
    ).toMatchObject({ status: "pending" });
  });
  it("never overrides a manual denial arriving during review", async () => {
    const deniedReview = async () => {
      await resolveActionApproval({ turn, invocationId: "call", decision: "denied", db });
      return review();
    };
    expect(
      await registerReviewedApproval(input, { ...deps(), review: deniedReview }),
    ).toMatchObject({ status: "denied" });
    expect(capture).not.toHaveBeenCalled();
  });
  it("invalidates automatic approval when the current request changes", async () => {
    await registerReviewedApproval(input, deps());
    await pg.exec(
      "UPDATE goat.codex_chat_turns SET prompt='Stop. Wait for my approval.' WHERE id='run'",
    );
    expect(await registerReviewedApproval(input, deps())).toMatchObject({
      status: "pending",
      automaticReview: { outcome: "requires_approval" },
    });
    expect(review).toHaveBeenCalledTimes(1);
  });
  it.each(["prompt", "interrupt"])(
    "does not commit after an in-flight %s change",
    async (change) => {
      const changedReview = async () => {
        await pg.exec(
          change === "prompt"
            ? "UPDATE goat.codex_chat_turns SET prompt='Wait for me' WHERE id='run'"
            : "UPDATE goat.codex_chat_turns SET interrupt_requested_at=now() WHERE id='run'",
        );
        return review();
      };
      expect(
        await registerReviewedApproval(input, { ...deps(), review: changedReview }),
      ).toMatchObject({ status: "pending" });
      expect(capture).not.toHaveBeenCalled();
    },
  );
  it("returns old-policy approvals to manual review", async () => {
    expect(await registerReviewedApproval(input, deps())).toMatchObject({ status: "approved" });
    await pg.exec(`UPDATE goat.action_turns SET approval_records =
      jsonb_set(approval_records, '{call,automaticReview,policy}', '"obsolete-policy"');`);
    const result = await registerReviewedApproval(input, deps());
    expect(result).toMatchObject({
      status: "pending",
      automaticReview: { outcome: "requires_approval", reason: "policy_changed" },
    });
    expect(result?.resolvedAt).toBeUndefined();
    expect(review).toHaveBeenCalledTimes(1);
  });
  it.each(["connection", "definition"])(
    "invalidates changed %s without re-review",
    async (change) => {
      const boundAction = {
        ...action,
        permission: {
          provider: "linear" as const,
          capabilityId: "read" as const,
          label: "Read Linear",
          integrationIds: ["connection-1"],
        },
      };
      expect(
        await registerReviewedApproval({ ...input, action: boundAction }, deps()),
      ).toMatchObject({
        status: "approved",
      });
      const changedAction =
        change === "connection"
          ? {
              ...boundAction,
              permission: { ...boundAction.permission, integrationIds: ["connection-2"] },
            }
          : { ...boundAction, description: "Changed action scope" };
      expect(
        await registerReviewedApproval({ ...input, action: changedAction }, deps()),
      ).toMatchObject({
        status: "pending",
        automaticReview: { outcome: "requires_approval", reason: "action_changed" },
      });
      expect(review).toHaveBeenCalledTimes(1);
    },
  );
  it("leaves fallback decisions pending without re-reviewing them", async () => {
    const fallback = vi.fn(async () => ({
      ...(await review()),
      outcome: "requires_approval" as const,
      reason: "unavailable" as const,
    }));
    expect(await registerReviewedApproval(input, { ...deps(), review: fallback })).toMatchObject({
      status: "pending",
    });
    expect(await registerReviewedApproval(input, { ...deps(), review: fallback })).toMatchObject({
      status: "pending",
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it("cannot auto-release a competing approval check", async () => {
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const slowReview = async () => {
      started();
      await waiting;
      return review();
    };
    const first = registerReviewedApproval(input, { ...deps(), review: slowReview });
    await starting;
    expect(await registerReviewedApproval(input, deps())).toMatchObject({
      status: "pending",
      automaticReview: { outcome: "requires_approval" },
    });
    finish();
    expect(await first).toMatchObject({ status: "pending" });
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
