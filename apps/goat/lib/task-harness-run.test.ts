import { describe, expect, it } from "vitest";
import { buildGoatHarnessRun, type GoatTaskHarnessRunInput } from "@/lib/task-harness-run";

describe("buildGoatHarnessRun", () => {
  it("matches assistant tool calls to successful tool results", () => {
    const run = buildGoatHarnessRun(
      task({
        debugTrace: {
          schemaVersion: "goat.debug.v1",
          planner: {
            model: "anthropic/claude-sonnet-4.6",
            request: { messages: [{ role: "user", content: "Plan the task" }] },
            response: { content: '{"tools":["exa","goat_result"]}' },
          },
          harness: {
            model: "openai/gpt-5.4-mini",
            systemPrompt: "Use tools and return goat_result.",
            turns: [
              {
                step: 0,
                requestMessages: [{ role: "user", content: "Research Marseille" }],
                responseMessage: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    toolCall("call_search", "exa_search", {
                      query: "Marseille history",
                      numResults: 5,
                    }),
                    toolCall("call_result", "goat_result", { text: "Done." }),
                  ],
                },
                toolResults: [
                  {
                    toolCallId: "call_search",
                    name: "exa_search",
                    args: { query: "Marseille history", numResults: 5 },
                    result: { results: [{ title: "Marseille", url: "https://example.com" }] },
                  },
                  {
                    toolCallId: "call_result",
                    name: "goat_result",
                    args: { text: "Done." },
                    result: { text: "Done." },
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    expect(run.hasTrace).toBe(true);
    expect(run.summary).toMatchObject({
      plannerModel: "anthropic/claude-sonnet-4.6",
      harnessModel: "openai/gpt-5.4-mini",
      turnCount: 1,
      toolCallCount: 2,
    });
    expect(run.harness?.turns[0]?.toolCalls[0]).toMatchObject({
      id: "call_search",
      name: "exa_search",
      label: "Web search",
      kind: "search",
      status: "completed",
      inputPreview: expect.stringContaining("Marseille history"),
      outputPreview: expect.stringContaining("Marseille"),
    });
    expect(run.harness?.turns[0]?.toolCalls[1]).toMatchObject({
      label: "Final result",
      kind: "result",
      outputPreview: expect.stringContaining("Done."),
    });
  });

  it("marks failed tool results and keeps the error preview separate", () => {
    const run = buildGoatHarnessRun(
      task({
        status: "failed",
        stage: "failed",
        debugTrace: {
          harness: {
            turns: [
              {
                step: 0,
                responseMessage: {
                  role: "assistant",
                  tool_calls: [toolCall("call_search", "exa_search", { query: "market" })],
                },
                toolResults: [
                  {
                    toolCallId: "call_search",
                    name: "exa_search",
                    args: { query: "market" },
                    error: "Exa search failed (429): too many requests",
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    expect(run.harness?.turns[0]?.toolCalls[0]).toMatchObject({
      status: "failed",
      errorPreview: "Exa search failed (429): too many requests",
      outputPreview: "",
    });
  });

  it("labels Gmail and Calendar tool results", () => {
    const run = buildGoatHarnessRun(
      task({
        debugTrace: {
          harness: {
            turns: [
              {
                step: 0,
                toolResults: [
                  {
                    toolCallId: "call_gmail",
                    name: "gmail_search",
                    args: { query: "newer_than:2d" },
                    result: { messages: [{ subject: "Launch" }] },
                  },
                  {
                    toolCallId: "call_calendar",
                    name: "calendar_list_events",
                    args: { calendarId: "primary" },
                    result: { events: [{ summary: "Planning" }] },
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    expect(run.harness?.turns[0]?.toolCalls.map((tool) => [tool.label, tool.kind])).toEqual([
      ["Search Gmail", "gmail"],
      ["List calendar events", "calendar"],
    ]);
  });

  it("returns an empty-state model for missing or malformed traces", () => {
    const run = buildGoatHarnessRun(
      task({
        debugTrace: {
          harness: {
            turns: [null, { responseMessage: null }],
          },
        } as never,
      }),
    );

    expect(run.hasTrace).toBe(false);
    expect(run.summary.turnCount).toBe(0);
    expect(run.summary.toolCallCount).toBe(0);
  });

  it("bounds long previews without truncating the raw trace JSON", () => {
    const longText = "x".repeat(2_000);
    const run = buildGoatHarnessRun(
      task({
        debugTrace: {
          harness: {
            turns: [
              {
                step: 0,
                toolResults: [
                  {
                    toolCallId: "call_search",
                    name: "exa_search",
                    args: { query: longText },
                    result: { text: longText },
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    const tool = run.harness?.turns[0]?.toolCalls[0];
    expect(tool?.inputPreview.length).toBeLessThanOrEqual(900);
    expect(tool?.inputPreview).toMatch(/\.\.\.$/);
    expect(tool?.outputPreview.length).toBeLessThanOrEqual(900);
    expect(tool?.rawJson).toContain(longText);
  });
});

function task(overrides: Partial<GoatTaskHarnessRunInput> = {}): GoatTaskHarnessRunInput {
  return {
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    status: "queued",
    stage: "queued",
    result: null,
    error: null,
    harnessSpec: {},
    debugTrace: {},
    ...overrides,
  };
}

function toolCall(id: string, name: string, args: unknown) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}
