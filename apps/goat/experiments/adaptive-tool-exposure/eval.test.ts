import { describe, expect, it } from "vitest";
import {
  runAdaptiveStaticEvaluation,
  scoreAdaptiveEvalCase,
  searchAdaptiveToolCatalog,
  summarizeAdaptiveEvalCases,
} from "./eval";
import { renderAdaptiveEvalReport } from "./eval-report";
import { ADAPTIVE_EVAL_TASKS, selectAdaptiveEvalTasks } from "./eval-tasks";
import type { AdaptiveEvalCase } from "./eval-types";
import { adaptiveToolByPointer } from "./registry";
import type { AdaptiveObservedCall } from "./types";

describe("adaptive exposure evaluation suite", () => {
  it("covers common, multi-integration, long-tail, implicit, and no-tool tasks", () => {
    expect(ADAPTIVE_EVAL_TASKS).toHaveLength(26);
    expect(new Set(ADAPTIVE_EVAL_TASKS.map((task) => task.category))).toEqual(
      new Set(["single", "multi", "long_tail", "implicit", "no_tool"]),
    );
    for (const task of ADAPTIVE_EVAL_TASKS) {
      for (const pointer of task.expectedToolPointers) {
        expect(adaptiveToolByPointer(pointer), `${task.id}: ${pointer}`).toBeTruthy();
      }
    }
  });

  it("selects named task subsets and rejects unknown tasks", () => {
    expect(selectAdaptiveEvalTasks(["slack-add-reaction"]).map((task) => task.id)).toEqual([
      "slack-add-reaction",
    ]);
    expect(() => selectAdaptiveEvalTasks(["missing-task"])).toThrow(
      "Unknown adaptive evaluation task",
    );
  });

  it("retrieves long-tail tools for the model-initiated search control", () => {
    expect(
      searchAdaptiveToolCatalog({
        query: "react with eyes emoji to a Slack message",
        integration: "slack",
      })[0]?.pointer,
    ).toBe("tool://slack/add_reaction");
    expect(
      searchAdaptiveToolCatalog({
        query: "list open pull requests",
        integration: "github",
      })[0]?.pointer,
    ).toBe("tool://github/list_pull_requests");
  });

  it("scores missing, extra, duplicate, and invalid calls", () => {
    const task = selectAdaptiveEvalTasks(["linear-create-issue"])[0]!;
    const expected = call("tool://linear/create_issue", true);

    expect(scoreAdaptiveEvalCase(task, [expected])).toMatchObject({
      requiredToolRecall: 1,
      toolPrecision: 1,
      exact: true,
      validCallRate: 1,
    });
    expect(scoreAdaptiveEvalCase(task, [expected, expected])).toMatchObject({
      requiredToolRecall: 1,
      toolPrecision: 1,
      exact: false,
    });
    expect(scoreAdaptiveEvalCase(task, [call("tool://linear/search_issues", true)])).toMatchObject({
      requiredToolRecall: 0,
      toolPrecision: 0,
      exact: false,
    });
    expect(scoreAdaptiveEvalCase(task, [call("tool://linear/create_issue", false)])).toMatchObject({
      requiredToolRecall: 0,
      exact: false,
      validCallRate: 0,
    });
  });

  it("does not let no-tool controls inflate micro-averaged recall", () => {
    const tasks = selectAdaptiveEvalTasks(["linear-create-issue", "no-tool-summary"]);
    const cases = tasks.map(
      (task) =>
        ({
          taskId: task.id,
          mode: "flat",
          calls: [],
          score: scoreAdaptiveEvalCase(task, []),
          firstStepInputTokens: 10,
          totalInputTokens: 10,
          steps: [],
          durationMs: 1,
          catalogSearches: 0,
          explicitLevel1Expansions: 0,
          explicitLevel2Expansions: 0,
          triggerFalseNegative: false,
          recoveredTriggerFalseNegative: false,
        }) as unknown as AdaptiveEvalCase,
    );

    const flat = summarizeAdaptiveEvalCases(cases, tasks).find(
      (summary) => summary.mode === "flat",
    );

    expect(flat?.meanRequiredToolRecall).toBe(0);
    expect(flat?.exactAccuracy).toBe(0.5);
  });

  it("measures the known deterministic miss and context scaling", () => {
    const result = runAdaptiveStaticEvaluation({ latencyIterations: 2 });

    expect(result.tasksWithTriggerFalseNegatives).toEqual(["implicit-slack-destination"]);
    expect(result.tasksWithCandidateMisses).toEqual(["implicit-slack-destination"]);
    expect(result.meanCandidateToolRecall).toBeGreaterThan(0.95);
    expect(result.meanEstimatedContextTokens.search).toBeLessThan(
      result.meanEstimatedContextTokens.adaptive,
    );
    expect(result.meanEstimatedContextTokens.adaptive).toBeLessThan(
      result.meanEstimatedContextTokens.flat,
    );
    expect(result.activationLatency.p95Ms).toBeLessThan(5);
    expect(result.scaling).toHaveLength(7);
    expect(result.scaling.at(-1)).toMatchObject({ integrations: 96, tools: 768 });
    for (let index = 1; index < result.scaling.length; index += 1) {
      expect(result.scaling[index]!.flatTokens).toBeGreaterThan(
        result.scaling[index - 1]!.flatTokens,
      );
    }
  });

  it("renders a reproducible static report", () => {
    const report = renderAdaptiveEvalReport({
      staticEvaluation: runAdaptiveStaticEvaluation({ latencyIterations: 1 }),
    });

    expect(report).toContain("# Adaptive Tool Exposure: Broad Evaluation");
    expect(report).toContain("**Flat:**");
    expect(report).toContain("implicit-slack-destination");
    expect(report).toContain("| 96 | 768 |");
  });
});

function call(pointer: string, valid: boolean): AdaptiveObservedCall {
  const [, integrationId = "unknown", toolName = "unknown"] = pointer.split(/[/:]+/);
  return {
    pointer,
    integrationId,
    toolName,
    arguments: {},
    valid,
    ...(valid ? {} : { error: "invalid" }),
  };
}
