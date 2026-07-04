import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildGoatHarnessRun } from "@/lib/task-harness-run";
import { TaskDetailPanel } from "./TaskDetailPanel";

describe("TaskDetailPanel cost summary", () => {
  it("renders a single total cost entry", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [],
      modelUsage: [
        modelUsage({
          total_cost_usd_micros: 1_100,
          provider_cost_usd_micros: 1_000,
          platform_fee_usd_micros: 100,
        }),
      ],
      toolUsage: [
        toolUsage({
          total_cost_usd_micros: 550,
          provider_cost_usd_micros: 500,
          platform_fee_usd_micros: 50,
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

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.4 Mini")).toBeInTheDocument();
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByText("$0.0019")).toBeInTheDocument();
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(screen.queryByText("Sandbox")).not.toBeInTheDocument();
    expect(
      screen.queryByText((_content, element) => element?.textContent === "exa / search (1)"),
    ).not.toBeInTheDocument();
  });

  it("renders zero total cost when no costs have been recorded", () => {
    const run = buildGoatHarnessRun({
      task: task(),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getAllByText("$0.0000").length).toBeGreaterThan(0);
    expect(screen.queryByText("Costs are recorded for new runs.")).not.toBeInTheDocument();
  });

  it("renders only the execution model when planner and execution models differ", () => {
    const run = buildGoatHarnessRun({
      task: task({ model: "anthropic/claude-sonnet-5" }),
      messages: [],
      events: [],
      modelUsage: [
        modelUsage({
          phase: "planner",
          model_name: "anthropic/claude-sonnet-4.6",
        }),
        modelUsage({
          id: 2,
          phase: "execution",
          model_name: "anthropic/claude-sonnet-5",
        }),
      ],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 5")).toBeInTheDocument();
    expect(screen.queryByText(/Claude Sonnet 4\.6/)).not.toBeInTheDocument();
  });
});

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Research Marseille",
    prompt: "Research Marseille",
    model: "openai/gpt-5.4-mini",
    status: "succeeded" as const,
    stage: "completed" as const,
    result: "Done.",
    error: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
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
    created_at: "2026-01-01T00:00:01.000Z",
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
