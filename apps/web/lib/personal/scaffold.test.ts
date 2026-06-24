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
  const onConflictDoNothing = vi.fn(() => ({ query: "insert" }));
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((value: unknown) => {
      insertedValues.push({ table, value });
      // `.values()` is consumed two ways: passed straight into db.batch([...]) by the new-agent
      // seed, and chained with `.onConflictDoNothing()` by the soul.md backfill — support both.
      return { query: "insert", onConflictDoNothing };
    }),
  }));
  const batch = vi.fn(async (queries: unknown[]) => queries);

  return {
    db: { select, insert, batch },
    insertedValues,
    batch,
    insert,
    onConflictDoNothing,
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
      personalBrainFolders: ["meetings", "strategy"],
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
    expect(agentInsert.config.model.name).toBe("moonshotai/kimi-k2.6");
    expect(result.defaultModel).toBe("moonshotai/kimi-k2.6");

    // The body's @-mentions are the source of truth for the default capability set: research
    // tools (exa/youtube/instagram), personal integrations (gmail/google_calendar/google_drive/slack), and
    // the thinking/writing skills — plus the dormant onboarding skill appended in code.
    expect(agentInsert.config.tools.map((tool) => tool.id)).toEqual([
      "exa",
      "youtube",
      "instagram",
      "gmail",
      "google_calendar",
      "google_drive",
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

    const agentFilePaths = insertedValues
      .filter((entry) => entry.table === agentFiles)
      .map((entry) => (entry.value as { path: string }).path);
    expect(agentFilePaths).toEqual([
      `${agentBundleDir(agentInsert.path)}/soul.md`,
      `${agentBundleDir(agentInsert.path)}/personal-brain/README.md`,
      `${agentBundleDir(agentInsert.path)}/personal-brain/meetings/README.md`,
      `${agentBundleDir(agentInsert.path)}/personal-brain/strategy/README.md`,
    ]);

    // Agent row + starter files are written atomically in one batch.
    expect(batch).toHaveBeenCalledOnce();
    // Local-only: nothing is enqueued for GitHub projection.
    expect(insertedValues.some((entry) => entry.table === workspaceSyncJobs)).toBe(false);
    expect(captureServerEventMock).toHaveBeenCalledWith("agent_created", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      agent_id: result.id,
    });
  });

  it("returns the existing agent without seeding when soul.md already exists", async () => {
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
            model: { name: "moonshotai/kimi-k2.6" },
          },
          version: 1,
        },
      ],
      // soul.md lookup: already present and already in the fixed-identity form, so the
      // normalize-on-boot step is a no-op and nothing is written.
      [{ content: DEFAULT_PERSONAL_SOUL_MD.replaceAll("{{userName}}", "Ada") }],
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

  it("backfills a personalized soul.md for an existing agent that is missing it", async () => {
    const { db, insertedValues, insert, batch, onConflictDoNothing } = createDbMock([
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
            model: { name: "moonshotai/kimi-k2.6" },
          },
          version: 1,
        },
      ],
      // soul.md lookup returns nothing — the agent predates soul.md seeding (#442).
      [],
    ]);
    getDbMock.mockReturnValue(db as never);

    const result = await ensurePersonalAgent({
      userId: "usr_123",
      workspaceId: "wks_123",
      userName: "Ada",
    });

    expect(result.id).toBe("agt_existing");
    // Backfilled outside any batch (single insert), so the Soul nav stops redirecting to /personal.
    expect(insert).toHaveBeenCalledOnce();
    expect(batch).not.toHaveBeenCalled();
    // Race-safe: concurrent first-loads must not collide on the unique (workspaceId, path) index.
    expect(onConflictDoNothing).toHaveBeenCalledOnce();

    const soulInsert = insertedValues.find((entry) => entry.table === agentFiles)?.value as {
      workspaceId: string;
      agentId: string;
      path: string;
      content: string;
      githubSyncStatus: string;
    };
    expect(soulInsert).toMatchObject({
      workspaceId: "wks_123",
      agentId: "agt_existing",
      path: "agents/personal-existing/soul.md",
      content: DEFAULT_PERSONAL_SOUL_MD.replaceAll("{{userName}}", "Ada"),
      githubSyncStatus: "synced",
    });
    expect(soulInsert.content).toContain("Ada");
    expect(soulInsert.content).toContain("Leo");
    expect(soulInsert.content).not.toContain("{{userName}}");
    // Re-scaffolding an existing agent is not an "agent_created" event.
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });
});
