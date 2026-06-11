import {
  agentBundleDir,
  FIRST_PRINCIPLES_SKILL_ID,
  HUMANIZER_SKILL_ID,
  ONBOARDING_SKILL_ID,
} from "@opencompany/agent-runtime";
import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { agentFiles, agents, workspaceSyncJobs } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERSONAL_SOUL_MD, ensurePersonalAgent } from "./scaffold";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn() })),
}));

const getDbMock = vi.mocked(getDb);
const captureServerEventMock = vi.mocked(captureServerEvent);

function createDbMock(selectResults: unknown[][]) {
  const pendingSelectResults = [...selectResults];
  const insertedValues: Array<{ table: unknown; value: unknown }> = [];

  const limit = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((value: unknown) => {
      insertedValues.push({ table, value });
      return { query: "insert" };
    }),
  }));
  const batch = vi.fn(async (queries: unknown[]) => queries);

  return {
    db: { select, insert, batch },
    insertedValues,
    batch,
    insert,
  };
}

describe("ensurePersonalAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates Leo and seeds a personalized soul.md in the same batch", async () => {
    const { db, insertedValues, batch } = createDbMock([[]]);
    getDbMock.mockReturnValue(db as never);

    const result = await ensurePersonalAgent({
      userId: "usr_123",
      workspaceId: "wks_123",
      userName: "Ada",
    });

    const agentInsert = insertedValues.find((entry) => entry.table === agents)?.value as {
      id: string;
      name: string;
      workspaceId: string;
      userId: string;
      isDefault: boolean;
      path: string;
      githubSyncStatus: string;
      config: AgentConfig;
    };
    expect(agentInsert).toMatchObject({
      id: result.id,
      name: "Leo",
      workspaceId: "wks_123",
      userId: "usr_123",
      isDefault: true,
      // Local-only: never projected to GitHub.
      githubSyncStatus: "synced",
    });

    // The body's @-mentions are the source of truth for the default capability set: research
    // tools (exa/youtube/instagram), personal integrations (gmail/google_calendar/slack), and
    // the thinking/writing skills — plus the dormant onboarding skill appended in code.
    expect(agentInsert.config.tools.map((tool) => tool.id)).toEqual([
      "exa",
      "youtube",
      "instagram",
      "gmail",
      "google_calendar",
      "slack",
    ]);
    expect(agentInsert.config.skills?.map((skill) => skill.id)).toEqual([
      FIRST_PRINCIPLES_SKILL_ID,
      HUMANIZER_SKILL_ID,
      ONBOARDING_SKILL_ID,
    ]);

    const expectedSoul = DEFAULT_PERSONAL_SOUL_MD.replaceAll("{{userName}}", "Ada");
    const soulInsert = insertedValues.find((entry) => entry.table === agentFiles)?.value as {
      workspaceId: string;
      agentId: string;
      path: string;
      content: string;
      githubSyncStatus: string;
    };
    expect(soulInsert).toMatchObject({
      workspaceId: "wks_123",
      agentId: result.id,
      path: `${agentBundleDir(agentInsert.path)}/soul.md`,
      content: expectedSoul,
      // Local-only too: no agent_file sync job, no GitHub projection.
      githubSyncStatus: "synced",
    });
    // The soul content is personalized for the user, while the agent identity stays fixed.
    expect(result.name).toBe("Leo");
    expect(soulInsert.content).toContain("Ada");
    expect(soulInsert.content).toContain("Leo");
    expect(soulInsert.content).not.toContain("{{userName}}");
    expect(DEFAULT_PERSONAL_SOUL_MD).not.toContain("Louis");

    // Agent row + soul.md are written atomically in one batch.
    expect(batch).toHaveBeenCalledOnce();
    // Local-only: nothing is enqueued for GitHub projection.
    expect(insertedValues.some((entry) => entry.table === workspaceSyncJobs)).toBe(false);
    expect(captureServerEventMock).toHaveBeenCalledWith("agent_created", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: result.id,
    });
  });

  it("returns the existing agent without seeding anything", async () => {
    const { db, insert, batch } = createDbMock([
      [
        {
          id: "agt_existing",
          name: "Leo",
          path: "agents/personal-existing/personal-existing.agent",
          body: "You are Leo, Ada's personal agent.\n\nexisting body",
          content: null,
          config: {
            title: "Leo",
            instructions: "You are Leo, Ada's personal agent.\n\nexisting body",
            model: { name: "minimax/minimax-m2.7-highspeed" },
          },
          version: 1,
        },
      ],
    ]);
    getDbMock.mockReturnValue(db as never);

    const result = await ensurePersonalAgent({
      userId: "usr_123",
      workspaceId: "wks_123",
      userName: "Ada",
    });

    expect(result.id).toBe("agt_existing");
    expect(insert).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });
});
