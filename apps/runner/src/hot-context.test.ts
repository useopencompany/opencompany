import { type AgentConfig, resolveAgentRuntimeConfig } from "@opencompany/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  __test,
  buildHotContextBlock,
  HOT_CONTEXT_TOKEN_CAP,
  type HotContextStore,
  loadSessionHotContextBlock,
  prependHotContextBlock,
} from "./hot-context";

describe("hot context", () => {
  it("builds a capped block with prioritized memory content", () => {
    const block = buildHotContextBlock({
      agentPath: "agents/leo/leo.agent",
      latestKeeperSummary: "Remembered the Atlas launch focus and a preference for crisp updates.",
      agentFiles: [
        {
          path: "agents/leo/user.md",
          content:
            "Ada leads product at OpenCompany. She prefers crisp, direct updates and wants risks called out early.",
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
        memoryFile({
          folder: "projects",
          id: "atlas-launch",
          type: "project",
          title: "Atlas launch",
          truth:
            "Current focus is shipping the Atlas launch checklist with owners and blockers. [^ev:atlas-call]",
          updatedAt: "2026-06-25T00:00:00.000Z",
        }),
        memoryFile({
          folder: "projects",
          id: "apollo-rollout",
          type: "project",
          title: "Apollo rollout",
          truth: "Secondary focus is preparing Apollo rollout notes for the support team.",
          updatedAt: "2026-06-20T00:00:00.000Z",
        }),
        memoryFile({
          folder: "projects",
          id: "older-project",
          type: "project",
          title: "Older project",
          truth: "This older project should not displace the two most recent projects.",
          updatedAt: "2026-05-01T00:00:00.000Z",
        }),
        memoryFile({
          folder: "themes",
          id: "communication-style",
          type: "theme",
          title: "Communication style",
          truth: "Standing preference: use concise recommendations and never bury blockers.",
          updatedAt: "2026-06-24T00:00:00.000Z",
        }),
        {
          path: "agents/leo/memory/evidence/conversations/atlas-call.md",
          content: "Evidence files are not included directly.",
          updatedAt: new Date("2026-06-26T00:00:00.000Z"),
        },
      ],
    });

    expect(block).not.toBeNull();
    expect(block).toMatch(/^<hot-context>\n/);
    expect(block).toContain("## User identity digest");
    expect(block).toContain("Ada leads product at OpenCompany");
    expect(block).toContain("- Atlas launch: Current focus is shipping");
    expect(block).toContain("- Apollo rollout: Secondary focus");
    expect(block).not.toContain("Older project:");
    expect(block).toContain("## Hard constraints / standing preferences");
    expect(block).toContain("Communication style");
    expect(block).toContain("## Most recent keeper summary");
    expect(block).toContain("</hot-context>");
    expect(__test.estimateTokenCount(block ?? "")).toBeLessThanOrEqual(HOT_CONTEXT_TOKEN_CAP);
  });

  it("truncates oversized input and keeps the closing tag inside the cap", () => {
    const block = buildHotContextBlock({
      agentPath: "agents/leo/leo.agent",
      latestKeeperSummary: "Remembered a lot.",
      agentFiles: [
        {
          path: "agents/leo/user.md",
          content: Array.from({ length: 5000 }, (_, index) => `fact${index}`).join(" "),
        },
      ],
    });

    expect(block).not.toBeNull();
    expect(block?.endsWith("</hot-context>")).toBe(true);
    expect(__test.estimateTokenCount(block ?? "")).toBeLessThanOrEqual(HOT_CONTEXT_TOKEN_CAP);
  });

  it("snapshots once and returns byte-identical context across later turns", async () => {
    const snapshots = new Map<string, string>();
    const store = fakeStore(snapshots);
    const buildSource = vi
      .fn()
      .mockResolvedValueOnce({
        agentPath: "agents/leo/leo.agent",
        latestKeeperSummary: "Remembered Ada's Atlas focus.",
        agentFiles: [{ path: "agents/leo/user.md", content: "Ada prefers concise updates." }],
      })
      .mockResolvedValueOnce({
        agentPath: "agents/leo/leo.agent",
        latestKeeperSummary: "This newer summary must not enter the existing session.",
        agentFiles: [{ path: "agents/leo/user.md", content: "Changed mid-session." }],
      });

    const first = await loadSessionHotContextBlock({
      enabled: true,
      sessionId: "ses_123",
      store,
      buildSource,
    });
    const second = await loadSessionHotContextBlock({
      enabled: true,
      sessionId: "ses_123",
      store,
      buildSource,
    });
    const third = await loadSessionHotContextBlock({
      enabled: true,
      sessionId: "ses_123",
      store,
      buildSource,
    });

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(buildSource).toHaveBeenCalledTimes(1);
  });

  it("returns the canonical snapshot for concurrent first-turn creation attempts", async () => {
    const snapshots = new Map<string, string>();
    const store = fakeCanonicalStore(snapshots);
    const buildSource = vi
      .fn()
      .mockResolvedValueOnce({
        agentPath: "agents/leo/leo.agent",
        latestKeeperSummary: "First runner summary.",
        agentFiles: [{ path: "agents/leo/user.md", content: "Ada prefers concise updates." }],
      })
      .mockResolvedValueOnce({
        agentPath: "agents/leo/leo.agent",
        latestKeeperSummary: "Second runner summary.",
        agentFiles: [{ path: "agents/leo/user.md", content: "Changed before retry." }],
      });

    const [first, second] = await Promise.all([
      loadSessionHotContextBlock({
        enabled: true,
        sessionId: "ses_concurrent",
        store,
        buildSource,
      }),
      loadSessionHotContextBlock({
        enabled: true,
        sessionId: "ses_concurrent",
        store,
        buildSource,
      }),
    ]);

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(snapshots.get("ses_concurrent")).toBe(first);
    expect(buildSource).toHaveBeenCalledTimes(2);
  });

  it("omits gracefully and snapshots empty when no digest exists", async () => {
    const snapshots = new Map<string, string>();
    const buildSource = vi.fn().mockResolvedValue({
      agentPath: "agents/leo/leo.agent",
      agentFiles: [],
      latestKeeperSummary: undefined,
    });

    const block = await loadSessionHotContextBlock({
      enabled: true,
      sessionId: "ses_empty",
      store: fakeStore(snapshots),
      buildSource,
    });

    expect(block).toBeNull();
    expect(snapshots.get("ses_empty")).toBe("");
    expect(buildSource).toHaveBeenCalledTimes(1);
  });

  it("does not read or snapshot when the caller gate is disabled", async () => {
    const store = fakeStore(new Map());
    const buildSource = vi.fn();
    const loadSnapshot = vi.spyOn(store, "loadSnapshot");
    const saveSnapshot = vi.spyOn(store, "saveSnapshot");

    const block = await loadSessionHotContextBlock({
      enabled: false,
      sessionId: "ses_company",
      store,
      buildSource,
    });

    expect(block).toBeNull();
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(buildSource).not.toHaveBeenCalled();
  });

  it("prepends additively without changing warm memory and recall tools", () => {
    const runtime = resolveAgentRuntimeConfig({
      agent: personalConfig(),
      personalAgent: true,
    });
    const toolsBefore = [...runtime.tools];
    const system = prependHotContextBlock(
      runtime.systemPrompt,
      "<hot-context>\nAda\n</hot-context>",
    );

    expect(system.startsWith("<hot-context>")).toBe(true);
    expect(runtime.tools).toEqual(toolsBefore);
    expect(runtime.tools).toContain("memory");
    expect(runtime.tools).toContain("recall");
  });
});

function fakeStore(snapshots: Map<string, string>): HotContextStore {
  return {
    async loadSnapshot(sessionId) {
      return snapshots.has(sessionId) ? snapshots.get(sessionId) : undefined;
    },
    async saveSnapshot(sessionId, block) {
      snapshots.set(sessionId, block);
      return block;
    },
    async loadLatestKeeperSummary() {
      return undefined;
    },
  };
}

function fakeCanonicalStore(snapshots: Map<string, string>): HotContextStore {
  return {
    async loadSnapshot(sessionId) {
      return snapshots.has(sessionId) ? snapshots.get(sessionId) : undefined;
    },
    async saveSnapshot(sessionId, block) {
      const existing = snapshots.get(sessionId);
      if (existing !== undefined) return existing;
      snapshots.set(sessionId, block);
      return block;
    },
    async loadLatestKeeperSummary() {
      return undefined;
    },
  };
}

function personalConfig(): AgentConfig {
  return {
    schemaVersion: "agent.v1",
    engine: "opencompany",
    title: "Personal agent",
    instructions: "Help the user.",
    model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
    tools: [],
    brain: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
  };
}

function memoryFile(input: {
  folder: string;
  id: string;
  type: string;
  title: string;
  truth: string;
  updatedAt: string;
}) {
  return {
    path: `agents/leo/memory/${input.folder}/${input.id}.md`,
    content: [
      "---",
      `id: ${input.id}`,
      `type: ${input.type}`,
      "status: active",
      "createdAt: 2026-06-01T00:00:00.000Z",
      `updatedAt: ${input.updatedAt}`,
      "related: []",
      "---",
      "",
      `# ${input.title}`,
      "",
      "## Compiled truth",
      input.truth,
      "",
      "<!-- TIMELINE:BELOW - append only past this marker -->",
      "",
      "## Timeline",
      "",
    ].join("\n"),
    updatedAt: new Date(input.updatedAt),
  };
}
