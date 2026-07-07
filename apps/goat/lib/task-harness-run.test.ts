import { describe, expect, it } from "vitest";
import { buildGoatHarnessRun, type GoatTaskRunEventInput } from "@/lib/task-harness-run";

describe("buildGoatHarnessRun", () => {
  it("builds a durable run transcript from messages and tool events", () => {
    const run = buildGoatHarnessRun({
      task: task({ status: "succeeded", stage: "completed", result: "Done." }),
      messages: [
        message({ id: "user_msg", role: "user", content: "Research Marseille" }),
        message({
          id: "assistant_msg",
          role: "assistant",
          status: "completed",
          content: "Done.",
        }),
      ],
      events: [
        event(1, "tool.started", {
          toolCallId: "call_search",
          toolName: "exa_search",
          input: { query: "Marseille history" },
        }),
        event(2, "tool.completed", {
          toolCallId: "call_search",
          toolName: "exa_search",
          input: { query: "Marseille history" },
          output: { results: [{ title: "Marseille", url: "https://example.com" }] },
        }),
      ],
    });

    expect(run.hasDurableRun).toBe(true);
    expect(run.userMessage?.content).toBe("Research Marseille");
    expect(run.assistantMessages[0]).toMatchObject({
      id: "assistant_msg",
      status: "completed",
      content: "Done.",
    });
    expect(run.toolCalls[0]).toMatchObject({
      id: "call_search",
      name: "exa_search",
      label: "Web search",
      kind: "search",
      status: "completed",
      inputPreview: expect.stringContaining("Marseille history"),
      outputPreview: expect.stringContaining("Marseille"),
    });
  });

  it("marks failed tool events and keeps the error preview separate", () => {
    const run = buildGoatHarnessRun({
      task: task({ status: "failed", stage: "failed", error: "Task failed." }),
      messages: [message({ id: "user_msg", role: "user", content: "Research" })],
      events: [
        event(1, "tool.started", {
          toolCallId: "call_search",
          toolName: "exa_search",
          input: { query: "market research" },
        }),
        event(2, "tool.failed", {
          toolCallId: "call_search",
          toolName: "exa_search",
          input: { query: "market research" },
          error: "Exa search failed (429): too many requests",
        }),
      ],
    });

    expect(run.toolCalls[0]).toMatchObject({
      status: "failed",
      outputPreview: "",
      errorPreview: "Exa search failed (429): too many requests",
    });
  });

  it("labels Gmail and Calendar tools", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [
        event(1, "tool.completed", {
          toolCallId: "call_gmail",
          toolName: "gmail_search",
          input: { query: "newer_than:2d" },
          output: { messages: [{ subject: "Launch" }] },
        }),
        event(2, "tool.completed", {
          toolCallId: "call_calendar",
          toolName: "calendar_list_events",
          input: { calendarId: "primary" },
          output: { events: [{ summary: "Planning" }] },
        }),
      ],
    });

    expect(run.toolCalls.map((tool) => [tool.label, tool.kind])).toEqual([
      ["Gmail search", "gmail"],
      ["Calendar events", "calendar"],
    ]);
  });

  it("labels X tools in the Results timeline", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [
        event(1, "tool.completed", {
          toolCallId: "call_x_posts",
          toolName: "x_get_user_posts",
          input: { username: "opencompany" },
          output: { posts: [{ caption: "launch" }] },
        }),
        event(2, "tool.completed", {
          toolCallId: "call_x_discussion",
          toolName: "x_get_discussion",
          input: { postIdOrUrl: "https://x.com/opencompany/status/123" },
          output: { comments: [{ text: "complaint" }] },
        }),
        event(3, "tool.completed", {
          toolCallId: "call_social_job",
          toolName: "social_get_job",
          input: { jobId: "job" },
          output: { status: "completed" },
        }),
      ],
    });

    expect(run.toolCalls.map((tool) => [tool.label, tool.kind])).toEqual([
      ["X posts", "tool"],
      ["X discussion", "tool"],
      ["Social job", "tool"],
    ]);
  });

  it("extracts brain report artifacts from durable events", () => {
    const run = buildGoatHarnessRun({
      task: task({
        status: "succeeded",
        stage: "completed",
        result: "Research report saved to Brain: [Market report](/brain/research/market-report).",
      }),
      messages: [],
      events: [
        event(1, "artifact.created", {
          artifact: {
            type: "brain_markdown_report",
            title: "Market report",
            documentId: "goat_brain_doc_1",
            brainId: "market-report",
            folderPath: "research",
            brainPath: "research/market-report.md",
            url: "/brain/research/market-report",
            mimeType: "text/markdown",
          },
        }),
      ],
    });

    expect(run.resultArtifact).toEqual({
      type: "brain_markdown_report",
      title: "Market report",
      documentId: "goat_brain_doc_1",
      brainId: "market-report",
      folderPath: "research",
      brainPath: "research/market-report.md",
      url: "/brain/research/market-report",
      mimeType: "text/markdown",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("ignores artifact events with non-brain URLs", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [
        event(1, "artifact.created", {
          artifact: {
            type: "brain_markdown_report",
            title: "Bad report",
            documentId: "goat_brain_doc_1",
            brainId: "bad-report",
            folderPath: "research",
            brainPath: "research/bad-report.md",
            url: "https://example.com/bad-report",
            mimeType: "text/markdown",
          },
        }),
      ],
    });

    expect(run.artifacts).toEqual([]);
    expect(run.resultArtifact).toBeNull();
  });

  it("returns a legacy fallback model when no durable rows exist", () => {
    const run = buildGoatHarnessRun({
      task: task({ status: "succeeded", stage: "completed", result: "Stored result." }),
      messages: [],
      events: [],
    });

    expect(run.hasDurableRun).toBe(false);
    expect(run.task.result).toBe("Stored result.");
    expect(run.legacyDetailText).toBe("Detailed run events are available for new tasks only.");
    expect(run.models).toEqual([
      {
        id: "openai/gpt-5.4-mini",
        label: "GPT 5.4 Mini",
        usageCount: 0,
        phases: [],
      },
    ]);
    expect(run.cost).toMatchObject({
      hasRecordedCosts: false,
      totalCostUsdMicros: 0,
      modelCostUsdMicros: 0,
      toolCostUsdMicros: 0,
      sandboxCostUsdMicros: 0,
    });
  });

  it("extracts Codex goal mode from harness specs", () => {
    const run = buildGoatHarnessRun({
      task: task({
        harnessSpec: {
          schemaVersion: "goat.harness.v1",
          engine: "codex",
          model: "openai/gpt-5.5",
          systemPrompt: "Use Codex.",
          initialUserMessage: "Fix tests.",
          tools: ["exa_search"],
          skills: [],
          maxModelSteps: 8,
          resultMode: "assistant_final",
          codex: {
            repository: "octo/repo",
            goalMode: {
              objective: "Fix tests and verify they pass.",
              tokenBudget: 200_000,
            },
          },
        },
      }),
      messages: [],
      events: [],
    });

    expect(run.harnessConfig?.codexGoalMode).toEqual({
      objective: "Fix tests and verify they pass.",
      tokenBudget: 200_000,
    });
  });

  it("summarizes the models used by model usage rows", () => {
    const run = buildGoatHarnessRun({
      task: task({ model: "openai/gpt-5.4-mini" }),
      messages: [],
      events: [],
      modelUsage: [
        modelUsage({ phase: "planner", model_name: "openai/gpt-5.4-mini" }),
        modelUsage({
          id: 2,
          phase: "execution",
          model_name: "anthropic/claude-sonnet-5",
        }),
        modelUsage({
          id: 3,
          phase: "execution",
          model_name: "anthropic/claude-sonnet-5",
        }),
      ],
    });

    expect(run.models).toEqual([
      {
        id: "openai/gpt-5.4-mini",
        label: "GPT 5.4 Mini",
        usageCount: 1,
        phases: ["planner"],
      },
      {
        id: "anthropic/claude-sonnet-5",
        label: "Claude Sonnet 5",
        usageCount: 2,
        phases: ["execution"],
      },
    ]);
  });

  it("aggregates model tool and sandbox costs", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [],
      modelUsage: [
        modelUsage({
          total_cost_usd_micros: 1_100,
          provider_cost_usd_micros: 1_000,
          platform_fee_usd_micros: 100,
          input_tokens: 40,
          output_tokens: 10,
          total_tokens: 50,
        }),
        modelUsage({
          id: 2,
          phase: "execution",
          step_index: 1,
          total_cost_usd_micros: 2_200,
          provider_cost_usd_micros: 2_000,
          platform_fee_usd_micros: 200,
          input_tokens: 30,
          output_tokens: 20,
          total_tokens: 50,
        }),
      ],
      toolUsage: [
        toolUsage({
          total_cost_usd_micros: 550,
          provider_cost_usd_micros: 500,
          platform_fee_usd_micros: 50,
        }),
        toolUsage({
          id: 2,
          total_cost_usd_micros: 330,
          provider_cost_usd_micros: 300,
          platform_fee_usd_micros: 30,
        }),
      ],
      sandboxUsage: [
        sandboxUsage({
          total_cost_usd_micros: 220,
          provider_cost_usd_micros: 200,
          platform_fee_usd_micros: 20,
        }),
      ],
    });

    expect(run.cost).toMatchObject({
      hasRecordedCosts: true,
      totalCostUsdMicros: 4_400,
      modelCostUsdMicros: 3_300,
      toolCostUsdMicros: 880,
      sandboxCostUsdMicros: 220,
      providerCostUsdMicros: 4_000,
      platformFeeUsdMicros: 400,
      tokens: {
        inputTokens: 70,
        outputTokens: 30,
        totalTokens: 100,
      },
      toolUsageByProviderOperation: [
        {
          provider: "exa",
          operation: "search",
          costUsdMicros: 880,
          providerCostUsdMicros: 800,
          platformFeeUsdMicros: 80,
          calls: 2,
        },
      ],
    });
  });

  it("aggregates Electric numeric string usage rows", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [],
      modelUsage: [
        modelUsage({
          total_cost_usd_micros: "1100",
          provider_cost_usd_micros: "1000",
          platform_fee_usd_micros: "100",
          input_tokens: "40",
          output_tokens: "10",
          total_tokens: "50",
        }),
      ],
      toolUsage: [
        toolUsage({
          total_cost_usd_micros: "550",
          provider_cost_usd_micros: "500",
          platform_fee_usd_micros: "50",
        }),
      ],
      sandboxUsage: [
        sandboxUsage({
          active_ms: "60000",
          total_cost_usd_micros: "220",
          provider_cost_usd_micros: "200",
          platform_fee_usd_micros: "20",
        }),
      ],
    });

    expect(run.cost).toMatchObject({
      hasRecordedCosts: true,
      totalCostUsdMicros: 1_870,
      modelCostUsdMicros: 1_100,
      toolCostUsdMicros: 550,
      sandboxCostUsdMicros: 220,
      providerCostUsdMicros: 1_700,
      platformFeeUsdMicros: 170,
      tokens: {
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
      },
    });
  });

  it("bounds long previews without truncating raw JSON", () => {
    const longText = "x".repeat(2_000);
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [
        event(1, "tool.completed", {
          toolCallId: "call_search",
          toolName: "exa_search",
          input: { query: longText },
          output: { text: longText },
        }),
      ],
    });

    const tool = run.toolCalls[0];
    expect(tool?.inputPreview.length).toBeLessThanOrEqual(900);
    expect(tool?.inputPreview).toMatch(/\.\.\.$/);
    expect(tool?.outputPreview.length).toBeLessThanOrEqual(900);
    expect(tool?.rawJson).toContain(longText);
  });
});

function task(overrides: Record<string, unknown> = {}) {
  return { ...taskBase(), ...overrides };
}

function modelUsage(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    task_id: "goat_task_1",
    user_workos_id: "user_1",
    message_id: null,
    run_lease_id: "lease_1",
    phase: "planner",
    step_index: 0,
    model_provider: "vercel-ai-gateway",
    model_name: "openai/gpt-5.4-mini",
    response_id: null,
    response_model_id: null,
    finish_reason: null,
    raw_finish_reason: null,
    input_tokens: 0,
    input_no_cache_tokens: 0,
    input_cache_read_tokens: 0,
    input_cache_write_tokens: 0,
    output_tokens: 0,
    output_text_tokens: 0,
    output_reasoning_tokens: 0,
    total_tokens: 0,
    raw_usage: {},
    provider_created_at: null,
    provider_cost_usd_micros: 0,
    platform_fee_usd_micros: 0,
    total_cost_usd_micros: 0,
    cost_basis: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function toolUsage(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    task_id: "goat_task_1",
    user_workos_id: "user_1",
    message_id: null,
    run_lease_id: "lease_1",
    tool_call_id: "call_search",
    tool_name: "exa_search",
    provider: "exa",
    operation: "search",
    provider_request_id: null,
    provider_cost_usd_micros: 0,
    platform_fee_usd_micros: 0,
    total_cost_usd_micros: 0,
    raw_usage: {},
    cost_basis: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sandboxUsage(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    task_id: "goat_task_1",
    user_workos_id: "user_1",
    message_id: null,
    run_lease_id: "lease_1",
    sandbox_id: "sbx_1",
    template: null,
    vcpu: 2,
    ram_mib: 512,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:01:00.000Z",
    active_ms: 60_000,
    provider_cost_usd_micros: 0,
    platform_fee_usd_micros: 0,
    total_cost_usd_micros: 0,
    raw_metrics: {},
    cost_basis: {},
    created_at: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function taskBase() {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    status: "running" as const,
    stage: "running" as const,
    result: null,
    error: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function message(overrides: {
  id: string;
  role: "user" | "assistant" | "tool";
  status?: "created" | "running" | "completed" | "failed";
  content?: string;
}) {
  return {
    id: overrides.id,
    taskId: "goat_task_1",
    userWorkosId: "user_1",
    role: overrides.role,
    status: overrides.status ?? "completed",
    content: overrides.content ?? "",
    modelMessage: null,
    toolName: null,
    toolCallId: null,
    responseToMessageId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function event(
  id: number,
  type: GoatTaskRunEventInput["type"],
  payload: Record<string, unknown>,
): GoatTaskRunEventInput {
  return {
    id,
    taskId: "goat_task_1",
    userWorkosId: "user_1",
    messageId: null,
    type,
    payload,
    createdAt: new Date(`2026-01-01T00:00:${String(id).padStart(2, "0")}.000Z`),
  };
}
