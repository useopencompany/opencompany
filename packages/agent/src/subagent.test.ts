import { WRITE_ARTIFACT_TOOL_NAME } from "@opencompany/agent-runtime";
import { BROWSER_TOOL_NAMES } from "@opencompany/browser-tools";
import { WIKI_TOOL_NAME } from "@opencompany/wiki/tool";
import { describe, expect, it, vi } from "vitest";
import { createProductChatToolContext, UPDATE_TASK_STATUS_TOOL_NAME } from "./chat-agent";
import {
  BRAIN_TOOL_NAME,
  BROWSER_USE_PROFILE_TOOL_NAME,
  CREATE_WORKSPACE_SKILL_TOOL_NAME,
  DELETE_TASK_SCHEDULE_TOOL_NAME,
  DESCRIBE_ACTIONS_TOOL_NAME,
  EDIT_TASK_SCHEDULE_TOOL_NAME,
  EDIT_WORKSPACE_SKILL_TOOL_NAME,
  LIST_ACTIONS_TOOL_NAME,
  LIST_SKILLS_TOOL_NAME,
  READ_SKILL_FILE_TOOL_NAME,
  SAVE_TO_BRAIN_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
  START_TASK_TOOL_NAME,
  START_WORKFLOW_TOOL_NAME,
  USE_ACTION_TOOL_NAME,
  USE_SKILL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "./chat-ui";
import {
  createSubagentBudget,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_RUNS_PER_TURN,
  MAX_SUBAGENT_SUMMARY_CHARS,
  SUBAGENT_INHERITED_TOOL_NAMES,
  SUBAGENT_TOOL_NAME,
  SUBAGENT_WITHHELD_TOOL_NAMES,
  subagentToolSet,
  truncateSubagentSummary,
} from "./subagent";
import { WORKSPACE_SKILLS_TOOL_NAME } from "./workspace-skill-tools";

const model = "moonshotai/kimi-k2.6" as never;

/**
 * Every runner a chat turn can inject, so the tool context below contains every tool the main
 * conversation can ever have. That is what makes the classification test below a real drift guard.
 */
function fullyLoadedToolContext() {
  return createProductChatToolContext({
    model,
    startTask: vi.fn(),
    scheduleTask: vi.fn(),
    editTaskSchedule: vi.fn(),
    deleteTaskSchedule: vi.fn(),
    workspaceSkills: vi.fn(),
    createWorkspaceSkill: vi.fn(),
    editWorkspaceSkill: vi.fn(),
    runBrainCli: vi.fn(),
    saveToBrain: vi.fn(),
    runWiki: vi.fn(),
    writeArtifact: vi.fn(),
    webFetch: vi.fn(),
    webSearch: vi.fn(),
    browserTools: vi.fn(),
    browserProfiles: { profiles: [], useProfile: vi.fn() },
    updateTaskStatus: vi.fn(),
    runSubagent: vi.fn(),
    actions: {
      catalog: {
        sources: [{ id: "linear", kind: "integration", label: "Linear", description: "Issues" }],
        actions: [
          {
            id: "linear.get_issue",
            source: "linear",
            description: "Read an issue",
            params: {},
            permissionMode: "on",
          },
        ],
      },
      execute: vi.fn(),
    } as never,
    skills: {
      catalog: [{ id: "skill_1", name: "pricing", description: "Pricing conventions" }],
      execute: vi.fn(),
      readFile: vi.fn(),
    },
    workflows: {
      catalog: [{ id: "wf_1", name: "ship-feature", description: "Ship a feature" }] as never,
      execute: vi.fn(),
    },
  });
}

describe("subagent tool inheritance", () => {
  it("classifies every tool the main conversation can have", () => {
    const { tools } = fullyLoadedToolContext();
    const classified = new Set([...SUBAGENT_INHERITED_TOOL_NAMES, ...SUBAGENT_WITHHELD_TOOL_NAMES]);

    const unclassified = Object.keys(tools).filter((name) => !classified.has(name));
    expect(
      unclassified,
      "A new chat tool must be added to SUBAGENT_INHERITED_TOOL_NAMES or SUBAGENT_WITHHELD_TOOL_NAMES so a subagent's access to it is a decision, not an accident.",
    ).toEqual([]);
  });

  it("inherits the read-only tools a subagent needs to do research", () => {
    const { tools } = fullyLoadedToolContext();
    const inherited = subagentToolSet(tools, { depth: 1 });

    for (const name of [
      BRAIN_TOOL_NAME,
      WIKI_TOOL_NAME,
      WEB_SEARCH_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      LIST_ACTIONS_TOOL_NAME,
      DESCRIBE_ACTIONS_TOOL_NAME,
      USE_ACTION_TOOL_NAME,
      LIST_SKILLS_TOOL_NAME,
      USE_SKILL_TOOL_NAME,
      READ_SKILL_FILE_TOOL_NAME,
    ]) {
      expect(name in inherited, `${name} should be inherited`).toBe(true);
    }
  });

  it("withholds every tool that writes, publishes, spawns, or schedules", () => {
    const { tools } = fullyLoadedToolContext();
    const inherited = subagentToolSet(tools, { depth: 1 });

    for (const name of [
      SAVE_TO_BRAIN_TOOL_NAME,
      WRITE_ARTIFACT_TOOL_NAME,
      CREATE_WORKSPACE_SKILL_TOOL_NAME,
      EDIT_WORKSPACE_SKILL_TOOL_NAME,
      WORKSPACE_SKILLS_TOOL_NAME,
      START_TASK_TOOL_NAME,
      START_WORKFLOW_TOOL_NAME,
      SCHEDULE_TASK_TOOL_NAME,
      EDIT_TASK_SCHEDULE_TOOL_NAME,
      DELETE_TASK_SCHEDULE_TOOL_NAME,
      UPDATE_TASK_STATUS_TOOL_NAME,
      BROWSER_USE_PROFILE_TOOL_NAME,
      ...BROWSER_TOOL_NAMES,
    ]) {
      expect(name in inherited, `${name} must not be inherited`).toBe(false);
    }
  });

  it("stops nesting at the depth limit", () => {
    const { tools } = fullyLoadedToolContext();

    expect(SUBAGENT_TOOL_NAME in subagentToolSet(tools, { depth: 1 })).toBe(true);
    expect(SUBAGENT_TOOL_NAME in subagentToolSet(tools, { depth: MAX_SUBAGENT_DEPTH })).toBe(false);
  });

  it("only offers the subagent tool when a runner is injected", () => {
    expect(SUBAGENT_TOOL_NAME in createProductChatToolContext({ model }).tools).toBe(false);
    expect(
      SUBAGENT_TOOL_NAME in createProductChatToolContext({ model, runSubagent: vi.fn() }).tools,
    ).toBe(true);
  });
});

describe("subagent budget", () => {
  it("refuses runs past the per-turn allowance", async () => {
    const budget = createSubagentBudget({ maxRunsPerTurn: 2, maxConcurrent: 2 });

    const first = await budget.acquire();
    const second = await budget.acquire();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const third = await budget.acquire();
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.error).toContain("2 subagent runs");
  });

  it("counts a released run against the turn allowance, so retries cannot loop forever", async () => {
    const budget = createSubagentBudget({ maxRunsPerTurn: 1, maxConcurrent: 1 });

    const first = await budget.acquire();
    expect(first.ok).toBe(true);
    if (first.ok) first.release();

    expect((await budget.acquire()).ok).toBe(false);
  });

  it("queues past the concurrency limit rather than failing", async () => {
    const budget = createSubagentBudget({ maxRunsPerTurn: 5, maxConcurrent: 1 });
    const first = await budget.acquire();
    expect(first.ok).toBe(true);

    let secondGranted = false;
    const second = budget.acquire().then((lease) => {
      secondGranted = lease.ok;
      return lease;
    });

    await Promise.resolve();
    expect(secondGranted, "the second run must wait for the first to finish").toBe(false);

    if (first.ok) first.release();
    expect((await second).ok).toBe(true);
  });

  it("releases a queued run when the turn is interrupted", async () => {
    const controller = new AbortController();
    const budget = createSubagentBudget({
      maxRunsPerTurn: 5,
      maxConcurrent: 1,
      signal: controller.signal,
    });
    const first = await budget.acquire();
    expect(first.ok).toBe(true);

    const queued = budget.acquire();
    controller.abort();

    const lease = await queued;
    expect(lease.ok).toBe(false);
    expect(lease.ok === false && lease.error).toContain("interrupted");
  });

  it("defaults to the calibrated turn and concurrency limits", () => {
    expect(MAX_SUBAGENT_RUNS_PER_TURN).toBe(16);
    expect(MAX_CONCURRENT_SUBAGENTS).toBe(8);
  });
});

describe("subagent summary", () => {
  it("returns a trimmed summary unchanged when it fits", () => {
    expect(truncateSubagentSummary("  the finding  ")).toEqual({
      summary: "the finding",
      truncated: false,
    });
  });

  it("caps an oversized summary and says so", () => {
    const result = truncateSubagentSummary("x".repeat(MAX_SUBAGENT_SUMMARY_CHARS + 500));

    expect(result.truncated).toBe(true);
    expect(result.summary).toContain("[Truncated:");
    expect(result.summary.startsWith("x".repeat(MAX_SUBAGENT_SUMMARY_CHARS))).toBe(true);
  });
});
