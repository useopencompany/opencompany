import { describe, expect, it } from "vitest";
import { buildHarnessRun } from "@/lib/task-harness-run";
import { applyInitialCostFloor } from "./TaskRunPanel";

describe("applyInitialCostFloor", () => {
  it("keeps the server cost when partial live cost rows would regress it to zero", () => {
    const initialRun = buildHarnessRun({
      task: task(),
      messages: [],
      events: [],
      modelUsage: [
        modelUsage({
          total_cost_usd_micros: 114_896,
          provider_cost_usd_micros: 104_451,
          platform_fee_usd_micros: 10_445,
        }),
      ],
    });
    const liveRun = buildHarnessRun({
      task: task({ status: "succeeded", stage: "completed" }),
      messages: [],
      events: [],
      toolUsage: [toolUsage()],
    });

    expect(liveRun.cost.totalCostUsdMicros).toBe(0);

    const merged = applyInitialCostFloor(liveRun, initialRun);

    expect(merged.cost).toEqual(initialRun.cost);
    expect(merged.task.status).toBe("succeeded");
  });

  it("uses live cost once it exceeds the server snapshot", () => {
    const initialRun = buildHarnessRun({
      task: task(),
      messages: [],
      events: [],
      modelUsage: [modelUsage({ total_cost_usd_micros: 100 })],
    });
    const liveRun = buildHarnessRun({
      task: task(),
      messages: [],
      events: [],
      modelUsage: [modelUsage({ total_cost_usd_micros: 150 })],
    });

    expect(applyInitialCostFloor(liveRun, initialRun).cost.totalCostUsdMicros).toBe(150);
  });
});

function task(overrides: Record<string, unknown> = {}) {
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
    tool_name: "linear_use_tool",
    provider: "linear",
    operation: "list_issues",
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
