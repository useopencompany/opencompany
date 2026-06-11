import { describe, expect, it } from "vitest";
import {
  derivePersonalSidebarSessions,
  deriveSessionDetailPlaceholder,
  deriveSidebarSessions,
} from "@/lib/collections/selectors";
import type { AgentRow, AgentSessionRow, SessionStarRow } from "@/lib/collections/types";

function makeSessionRow(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: "ses_1",
    workspace_id: "wks_1",
    user_id: "usr_1",
    agent_id: "agt_1",
    title: "Session one",
    status: "running",
    source: "user",
    model_provider: "anthropic",
    model_name: "claude",
    parent_session_id: null,
    parent_message_id: null,
    parent_tool_call_id: null,
    e2b_sandbox_id: null,
    workdir: "/tmp",
    last_error: null,
    abort_requested_at: null,
    archived_at: null,
    last_turn_finished_at: null,
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function makeStarRow(overrides: Partial<SessionStarRow> = {}): SessionStarRow {
  return {
    user_id: "usr_1",
    session_id: "ses_1",
    starred_at: "2026-01-03T00:00:00.000Z",
    ...overrides,
  };
}

function makeAgentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agt_1",
    name: "Builder",
    path: "team/builder",
    ...overrides,
  } as unknown as AgentRow;
}

describe("deriveSessionDetailPlaceholder", () => {
  it("returns null until the session row has synced", () => {
    expect(deriveSessionDetailPlaceholder("ses_missing", [makeSessionRow()], [])).toBeNull();
  });

  it("maps the session row + agent join into the detail payload with empty server-only fields", () => {
    const placeholder = deriveSessionDetailPlaceholder(
      "ses_1",
      [makeSessionRow()],
      [makeAgentRow()],
    );

    expect(placeholder).not.toBeNull();
    expect(placeholder?.session).toMatchObject({
      id: "ses_1",
      agentId: "agt_1",
      agentName: "Builder",
      agentPath: "team/builder",
      title: "Session one",
      status: "running",
      modelProvider: "anthropic",
      modelName: "claude",
      // Not synced into the agent_sessions shape — null in the instant placeholder.
      runLeaseId: null,
    });
    // Transcript history floor + recursive aggregates are filled by the server fetch.
    expect(placeholder?.messages).toEqual([]);
    expect(placeholder?.events).toEqual([]);
    expect(placeholder?.usage.totalTokens).toBe(0);
    expect(placeholder?.cost.totalCostUsdMicros).toBe(0);
    expect(placeholder?.toolUsage.byProviderOperation).toEqual([]);
  });

  it("falls back to empty agent name/path when the agent has not synced yet", () => {
    const placeholder = deriveSessionDetailPlaceholder("ses_1", [makeSessionRow()], []);

    expect(placeholder?.session.agentName).toBe("");
    expect(placeholder?.session.agentPath).toBeNull();
  });

  it("derives the parent + children related tree from the collection", () => {
    const parent = makeSessionRow({ id: "ses_parent", title: "Parent" });
    const target = makeSessionRow({ id: "ses_1", parent_session_id: "ses_parent" });
    const childB = makeSessionRow({
      id: "ses_child_b",
      title: "Child B",
      parent_session_id: "ses_1",
      created_at: "2026-01-03T00:00:00.000Z",
    });
    const childA = makeSessionRow({
      id: "ses_child_a",
      title: "Child A",
      parent_session_id: "ses_1",
      created_at: "2026-01-01T12:00:00.000Z",
    });

    const placeholder = deriveSessionDetailPlaceholder(
      "ses_1",
      [parent, target, childB, childA],
      [makeAgentRow()],
    );

    expect(placeholder?.related.parent?.id).toBe("ses_parent");
    // Children ordered by created_at ascending.
    expect(placeholder?.related.children.map((child) => child.id)).toEqual([
      "ses_child_a",
      "ses_child_b",
    ]);
  });
});

describe("derivePersonalSidebarSessions", () => {
  it("sorts sessions by created time, not updated time", () => {
    const sessions = [
      makeSessionRow({
        id: "older-updated",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-04T00:00:00.000Z",
      }),
      makeSessionRow({
        id: "newer-created",
        created_at: "2026-01-03T00:00:00.000Z",
        updated_at: "2026-01-03T00:00:00.000Z",
      }),
    ];

    expect(
      derivePersonalSidebarSessions("agt_1", sessions, []).map((session) => session.id),
    ).toEqual(["newer-created", "older-updated"]);
  });

  it("joins pin state and keeps personal web and WhatsApp sessions only", () => {
    const sessions = [
      makeSessionRow({ id: "web", title: "Web", source: "user" }),
      makeSessionRow({ id: "whatsapp", title: "WhatsApp", source: "whatsapp" }),
      makeSessionRow({ id: "delegated", title: "Delegated", source: "agent" }),
      makeSessionRow({ id: "other-agent", title: "Other", agent_id: "agt_2" }),
      makeSessionRow({
        id: "archived",
        title: "Archived",
        archived_at: "2026-01-04T00:00:00.000Z",
      }),
    ];

    const derived = derivePersonalSidebarSessions("agt_1", sessions, [
      makeStarRow({ session_id: "whatsapp" }),
    ]);

    expect(derived.map((session) => session.id)).toEqual(["web", "whatsapp"]);
    expect(derived.find((session) => session.id === "whatsapp")?.starredAt).toBe(
      "2026-01-03T00:00:00.000Z",
    );
  });

  it("keeps pinned sessions outside the recency window", () => {
    const base = Date.parse("2026-01-02T00:00:00.000Z");
    const sessions = Array.from({ length: 52 }, (_, index) =>
      makeSessionRow({
        id: `ses_${index}`,
        created_at: new Date(base - index * 60_000).toISOString(),
        updated_at: new Date(base + index * 60_000).toISOString(),
      }),
    );

    const derived = derivePersonalSidebarSessions("agt_1", sessions, [
      makeStarRow({
        session_id: "ses_51",
        starred_at: "2026-01-03T00:00:00.000Z",
      }),
    ]);

    expect(derived).toHaveLength(51);
    expect(derived.map((session) => session.id)).toContain("ses_51");
    expect(derived.map((session) => session.id)).not.toContain("ses_50");
  });
});

describe("deriveSidebarSessions", () => {
  it("sorts workspace sessions by created time, not updated time", () => {
    const sessions = [
      makeSessionRow({
        id: "older-updated",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-04T00:00:00.000Z",
      }),
      makeSessionRow({
        id: "newer-created",
        created_at: "2026-01-03T00:00:00.000Z",
        updated_at: "2026-01-03T00:00:00.000Z",
      }),
    ];

    expect(deriveSidebarSessions(sessions, []).map((session) => session.id)).toEqual([
      "newer-created",
      "older-updated",
    ]);
  });
});
