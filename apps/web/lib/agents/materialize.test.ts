import { serializeAgentFile } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashAgentSource } from "@/lib/agents/hash";
import { materializeAgentToGitHub } from "@/lib/agents/materialize";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
  })),
  endTimingTrace: vi.fn(),
  startTimingTrace: vi.fn(() => undefined),
  timeAsync: vi.fn(async (_trace, _step, run) => run()),
}));

const getDbMock = vi.mocked(getDb);

describe("materializeAgentToGitHub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks unchanged pending agents as synced and clears their sync job", async () => {
    const source = serializeAgentFile({
      title: "Leo",
      body: "Help with issues",
      model: "openai/gpt-5.4-mini",
      tools: [],
      brain: [],
      skills: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    });
    const contentHash = hashAgentSource(source);
    const updateSet = vi.fn(() => ({ where: vi.fn(() => ({ query: "update-agent" })) }));
    const deleteWhere = vi.fn(() => ({ query: "delete-sync-job" }));
    const db = {
      batch: vi.fn(async () => []),
      delete: vi.fn(() => ({ where: deleteWhere })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(async () => [
                  {
                    agent: {
                      id: "agt_123",
                      workspaceId: "wks_123",
                      path: "agents/leo.agent",
                      name: "Leo",
                      body: "Help with issues",
                      contentHash,
                      githubBlobSha: "blob_123",
                      githubSyncedHash: contentHash,
                      githubSyncStatus: "pending",
                      config: {
                        model: { name: "openai/gpt-5.4-mini" },
                        tools: [],
                        brain: [],
                        skills: [],
                        integrations: { github: { repositories: [] } },
                        triggers: [],
                      },
                    },
                    workspace: { id: "wks_123" },
                    job: {
                      agentId: "agt_123",
                      desiredHash: contentHash,
                      desiredVersion: 2,
                      attempts: 0,
                      previousPath: null,
                      previousBlobSha: null,
                    },
                  },
                ]),
              })),
            })),
          })),
        })),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    };
    getDbMock.mockReturnValue(db as never);

    await expect(materializeAgentToGitHub("agt_123")).resolves.toEqual({ status: "unchanged" });

    expect(updateSet).toHaveBeenCalledWith({
      githubSyncStatus: "synced",
      githubSyncError: null,
    });
    expect(deleteWhere).toHaveBeenCalled();
    expect(db.batch).toHaveBeenCalledWith([
      { query: "update-agent" },
      { query: "delete-sync-job" },
    ]);
  });
});
