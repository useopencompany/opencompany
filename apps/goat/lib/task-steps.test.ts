import { describe, expect, it } from "vitest";
import { deriveGoatTaskSteps, type GoatTaskStepInput } from "@/lib/task-steps";

describe("deriveGoatTaskSteps", () => {
  it("returns a pending step for queued tasks with no trace", () => {
    expect(deriveGoatTaskSteps(task())).toEqual(["Waiting for the runner to start the task."]);
  });

  it("uses stage progress when a running task has only coarse state", () => {
    expect(
      deriveGoatTaskSteps(
        task({
          status: "running",
          stage: "running",
          harnessSpec: defaultHarnessSpec(),
          sandboxId: "sbx_123",
        }),
      ),
    ).toEqual([
      "Prepared the task request for the research harness.",
      "Preparing the task workspace.",
      "Running the research harness and collecting results.",
    ]);
  });

  it("summarizes a successful searched task without exposing tool payloads", () => {
    expect(
      deriveGoatTaskSteps(
        task({
          status: "succeeded",
          stage: "completed",
          result: "Done.",
          sandboxId: "sbx_123",
          debugTrace: traceWithTools([
            {
              name: "exa_search",
              args: { query: "Marseille history", numResults: 5 },
              result: {
                results: [{ title: "Long raw search result that should not be exposed" }],
              },
            },
            { name: "goat_result", args: { text: "Done." }, result: { text: "Done." } },
          ]),
        }),
      ),
    ).toEqual([
      "Planned the task and selected the research harness.",
      "Prepared the task workspace.",
      'Searched the web for "Marseille history".',
      "Synthesized the findings into the final result.",
    ]);
  });

  it("dedupes repeated searches and groups multiple topics", () => {
    const steps = deriveGoatTaskSteps(
      task({
        status: "succeeded",
        stage: "completed",
        result: "Done.",
        debugTrace: traceWithTools([
          { name: "exa_search", args: { query: "AI agents" } },
          { name: "exa_search", args: { query: "agent observability" } },
          { name: "exa_search", args: { query: "ai agents" } },
          { name: "exa_search", args: { query: "tool calling traces" } },
          { name: "goat_result", args: { text: "Done." } },
        ]),
      }),
    );

    expect(steps).toContain(
      'Searched the web for "AI agents", "agent observability", and 1 more topic.',
    );
    expect(steps.filter((step) => step.includes("Searched the web"))).toHaveLength(1);
  });

  it("separates deeper follow-up searches", () => {
    expect(
      deriveGoatTaskSteps(
        task({
          status: "succeeded",
          stage: "completed",
          result: "Done.",
          debugTrace: traceWithTools([
            { name: "exa_search", args: { query: "AI agent task traces", type: "fast" } },
            {
              name: "exa_search",
              args: { query: "OpenTelemetry GenAI tool conventions", type: "deep-reasoning" },
            },
            { name: "goat_result", args: { text: "Done." } },
          ]),
        }),
      ),
    ).toEqual([
      "Planned the task and selected the research harness.",
      'Searched the web for "AI agent task traces".',
      'Went deeper on "OpenTelemetry GenAI tool conventions".',
      "Synthesized the findings into the final result.",
    ]);
  });

  it("handles a single deep search without duplicating it", () => {
    const steps = deriveGoatTaskSteps(
      task({
        status: "succeeded",
        stage: "completed",
        result: "Done.",
        debugTrace: traceWithTools([
          { name: "exa_search", args: { query: "advanced retrieval methods", type: "deep" } },
          { name: "goat_result", args: { text: "Done." } },
        ]),
      }),
    );

    expect(steps).toContain('Searched deeply for "advanced retrieval methods".');
    expect(steps.filter((step) => step.includes("advanced retrieval methods"))).toHaveLength(1);
  });

  it("handles malformed traces with safe fallback steps", () => {
    expect(
      deriveGoatTaskSteps(
        task({
          status: "succeeded",
          stage: "completed",
          result: "Done.",
          debugTrace: {
            harness: {
              turns: [{ toolResults: [null, { name: "exa_search", args: null }] }],
            },
          } as never,
        }),
      ),
    ).toEqual([
      "Prepared the task request for the research harness.",
      "Synthesized the findings into the final result.",
    ]);
  });

  it("summarizes failed tool calls without exposing raw debug JSON", () => {
    const steps = deriveGoatTaskSteps(
      task({
        status: "failed",
        stage: "failed",
        error: "Goat harness failed.",
        debugTrace: traceWithTools([
          {
            name: "exa_search",
            args: { query: "market research" },
            error: "Exa search failed (429): too many requests",
          },
        ]),
      }),
    );

    expect(steps).toEqual([
      "Planned the task and selected the research harness.",
      'Searched the web for "market research".',
      "Stopped after an error: Exa search failed (429): too many requests.",
    ]);
  });
});

function task(overrides: Partial<GoatTaskStepInput> = {}): GoatTaskStepInput {
  return {
    status: "queued",
    stage: "queued",
    result: null,
    error: null,
    harnessSpec: defaultHarnessSpec(),
    debugTrace: {},
    sandboxId: null,
    ...overrides,
  };
}

function defaultHarnessSpec(): GoatTaskStepInput["harnessSpec"] {
  return {
    schemaVersion: "goat.harness.v1",
    model: "openai/gpt-5.4-mini",
    systemPrompt: "Run the task.",
    initialUserMessage: "Research Marseille",
    tools: ["exa_search"],
    maxModelSteps: 8,
    resultMode: "assistant_final",
  };
}

function traceWithTools(toolResults: unknown[]): GoatTaskStepInput["debugTrace"] {
  return {
    schemaVersion: "goat.debug.v1",
    planner: {
      model: "openai/gpt-5.4-mini",
      response: { content: "{}" },
    },
    harness: {
      model: "openai/gpt-5.4-mini",
      turns: [{ step: 0, toolResults }],
    },
  };
}
