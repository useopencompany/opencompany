import { describe, expect, it } from "vitest";
import { deriveSidebarSessions, deriveSessionDetailPlaceholder } from "@/lib/collections/selectors";
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
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

function makeStarRow(overrides: Partial<SessionStarRow> = {}): SessionStarRow {
  return {
    user_id: "usr_1",
    session_id: "ses_1",
    starred_at: "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("deriveSidebarSessions", () => {
  it("orders sessions by updatedAt descending (most recently active first)", () => {
    const older = makeSessionRow({
      id: "ses_older",
      updated_at: "2026-01-01T08:00:00.000Z",
    });
    const newer = makeSessionRow({
      id: "ses_newer",
      updated_at: "2026-01-03T10:00:00.000Z",
    });
    const middle = makeSessionRow({
      id: "ses_middle",
      updated_at: "2026-01-02T12:00:00.000Z",
    });

    const result = deriveSidebarSessions([older, newer, middle], []);
    expect(result.map((s) => s.id)).toEqual(["ses_newer", "ses_middle", "ses_older"]);
  });

  it("excludes archived sessions", () => {
    const active = makeSessionRow({ id: "ses_active" });
    const archived = makeSessionRow({ id: "ses_archived", archived_at: "2026-01-01T00:00:00.000Z" });

    const result = deriveSidebarSessions([active, archived], []);
    expect(result.map((s) => s.id)).toEqual(["ses_active"]);
  });

  it("excludes agent-sourced sessions", () => {
    const user = makeSessionRow({ id: "ses_user", source: "user" });
    const agent = makeSessionRow({ id: "ses_agent", source: "agent" });

    const result = deriveSidebarSessions([user, agent], []);
    expect(result.map((s) => s.id)).toEqual(["ses_user"]);
  });

  it("excludes archiving and archived statuses", () => {
    const running = makeSessionRow({ id: "ses_running", status: "running" });
    const archiving = makeSessionRow({ id: "ses_archiving", status: "archiving" });
    const archived = makeSessionRow({ id: "ses_archived_status", status: "archived" });

    const result = deriveSidebarSessions([running, archiving, archived], []);
    expect(result.map((s) => s.id)).toEqual(["ses_running"]);
  });

  it("joins star state from the stars collection", () => {
    const session = makeSessionRow({ id: "ses_1" });
    const star = makeStarRow({ session_id: "ses_1", starred_at: "2026-02-01T00:00:00.000Z" });

    const [result] = deriveSidebarSessions([session], [star]);
    expect(result?.starredAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("returns null starredAt for unstarred sessions", () => {
    const session = makeSessionRow({ id: "ses_1" });

    const [result] = deriveSidebarSessions([session], []);
    expect(result?.starredAt).toBeNull();
  });

  it("keeps starred sessions beyond the recency limit", () => {
    // Create 51 sessions; the last one (oldest) is starred.
    const sessions = Array.from({ length: 51 }, (_, i) =>
      makeSessionRow({
        id: `ses_${i}`,
        updated_at: new Date(2026, 0, 52 - i).toISOString(), // newest first by id
      }),
    );
    // ses_50 is the oldest; pin it.
    const star = makeStarRow({ session_id: "ses_50", starred_at: "2026-01-01T00:00:00.000Z" });

    const result = deriveSidebarSessions(sessions, [star]);
    // First 50 recency + the starred stale session = 51 total.
    expect(result.length).toBe(51);
    expect(result.some((s) => s.id === "ses_50")).toBe(true);
  });

  it("caps unstarred sessions at the recency limit (50)", () => {
    const sessions = Array.from({ length: 55 }, (_, i) =>
      makeSessionRow({
        id: `ses_${i}`,
        updated_at: new Date(2026, 0, 56 - i).toISOString(),
      }),
    );

    const result = deriveSidebarSessions(sessions, []);
    expect(result.length).toBe(50);
  });
});

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
