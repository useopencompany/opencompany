import { describe, expect, it } from "vitest";
import { deriveSessionDetailPlaceholder } from "@/lib/collections/selectors";
import type { AgentRow, AgentSessionRow } from "@/lib/collections/types";

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
