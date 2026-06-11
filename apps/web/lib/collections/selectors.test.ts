import { describe, expect, it } from "vitest";
import {
  derivePersonalFilesFromAgentRows,
  derivePersonalSidebarSessions,
  deriveSessionDetailPlaceholder,
} from "@/lib/collections/selectors";
import type {
  AgentFileRow,
  AgentRow,
  AgentSessionRow,
  SessionStarRow,
} from "@/lib/collections/types";

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

function makeAgentFileRow(overrides: Partial<AgentFileRow>): AgentFileRow {
  return {
    id: 1,
    workspace_id: "wks_123",
    agent_id: "agt_123",
    path: "agents/personal/personal-brain/a.md",
    content: "A",
    content_hash: "hash-a",
    size_bytes: 1,
    github_blob_sha: null,
    github_commit_sha: null,
    github_synced_hash: null,
    github_synced_at: null,
    github_sync_status: "synced",
    github_sync_error: null,
    created_at: "2026-06-11T10:00:00.000Z",
    updated_at: "2026-06-11T10:00:00.000Z",
    ...overrides,
  };
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
        updated_at: new Date(base - index * 60_000).toISOString(),
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

describe("derivePersonalFilesFromAgentRows", () => {
  it("filters to the requested bundle prefix and strips it from paths", () => {
    const prefix = "agents/personal/personal-brain/";
    const files = derivePersonalFilesFromAgentRows(
      [
        makeAgentFileRow({ id: 2, path: "agents/personal/personal-brain/z.md", content: "Z" }),
        makeAgentFileRow({ id: 1, path: "agents/personal/personal-brain/a.md", content: "A" }),
        makeAgentFileRow({ id: 3, path: "agents/personal/memory/user.md", content: "Memory" }),
        makeAgentFileRow({ id: 4, path: "agents/other/personal-brain/a.md", content: "Other" }),
      ],
      prefix,
    );

    expect(files.map((file) => file.path)).toEqual(["a.md", "z.md"]);
    expect(files).toEqual([
      expect.objectContaining({ id: 1, repoPath: `${prefix}a.md`, content: "A" }),
      expect.objectContaining({ id: 2, repoPath: `${prefix}z.md`, content: "Z" }),
    ]);
  });

  it("preserves content metadata for memory rows", () => {
    const prefix = "agents/personal/memory/";
    const files = derivePersonalFilesFromAgentRows(
      [
        makeAgentFileRow({
          id: 10,
          path: "agents/personal/memory/people/louis.md",
          content: "Truth",
          content_hash: "hash-truth",
          size_bytes: 5,
          updated_at: "2026-06-11T11:00:00.000Z",
        }),
      ],
      prefix,
    );

    expect(files).toEqual([
      expect.objectContaining({
        id: 10,
        repoPath: "agents/personal/memory/people/louis.md",
        path: "people/louis.md",
        content: "Truth",
        contentHash: "hash-truth",
        sizeBytes: 5,
        updatedAt: "2026-06-11T11:00:00.000Z",
      }),
    ]);
  });
});
