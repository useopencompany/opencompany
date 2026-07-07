import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoatHarnessRun } from "@/lib/task-harness-run";
import { TaskDetailPanel } from "./TaskDetailPanel";

const mocks = vi.hoisted(() => ({
  cancelGoatTaskAction: vi.fn(),
  continueGoatTaskAction: vi.fn(),
  routerRefresh: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/tasks", () => ({
  cancelGoatTaskAction: mocks.cancelGoatTaskAction,
  continueGoatTaskAction: mocks.continueGoatTaskAction,
}));

vi.mock("@opencompany/ui/components/sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mocks.routerRefresh,
  }),
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => false,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelGoatTaskAction.mockResolvedValue({ ok: true, error: null });
  mocks.continueGoatTaskAction.mockResolvedValue({
    ok: true,
    taskId: "goat_task_1",
    displayId: "TASK-1",
    messageId: "goat_task_msg_1",
  });
});

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

describe("TaskDetailPanel harness config", () => {
  it("renders the selected harness tools and config summary", () => {
    const run = buildGoatHarnessRun({
      task: task({
        harnessSpec: {
          schemaVersion: "goat.harness.v1",
          engine: "codex",
          model: "openai/gpt-5.4-mini",
          systemPrompt: "",
          initialUserMessage: "Research Marseille",
          tools: ["exa_search", "gmail_search", "linear_search_tools"],
          skills: ["first-principles"],
          maxModelSteps: 6,
          resultMode: "brain_markdown_report",
          codex: {
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

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByText("Harness")).toBeInTheDocument();
    expect(screen.getByText("Engine")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Web search")).toBeInTheDocument();
    expect(screen.getByText("Gmail search")).toBeInTheDocument();
    expect(screen.getByText("Linear tools")).toBeInTheDocument();
    expect(
      screen.getByText("GPT 5.4 Mini - 6 max steps - Brain report - 1 skill"),
    ).toBeInTheDocument();
    expect(screen.getByText("Goal")).toBeInTheDocument();
    expect(
      screen.getByText("Fix tests and verify they pass. - 200000 token budget"),
    ).toBeInTheDocument();
  });
});

describe("TaskDetailPanel stop action", () => {
  it("renders a stop button for active tasks and calls the cancel action", async () => {
    const user = userEvent.setup();
    const run = buildGoatHarnessRun({
      task: task({ status: "running", stage: "running", result: null }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    const stopButton = screen.getByRole("button", { name: "Stop" });
    await user.click(stopButton);

    expect(mocks.cancelGoatTaskAction).toHaveBeenCalledWith("goat_task_1");
    expect(screen.getByRole("button", { name: "Stopping" })).toBeDisabled();
  });

  it("resets the stop button when the cancel action fails", async () => {
    mocks.cancelGoatTaskAction.mockResolvedValue({ ok: false, error: "Nope." });
    const user = userEvent.setup();
    const run = buildGoatHarnessRun({
      task: task({ status: "running", stage: "running", result: null }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("Nope.");
      expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    });
  });

  it("resets the stop button when the cancel action throws", async () => {
    mocks.cancelGoatTaskAction.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    const run = buildGoatHarnessRun({
      task: task({ status: "running", stage: "running", result: null }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("Could not stop task.");
      expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    });
  });

  it.each([
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["canceled", "canceled"],
  ] as const)("does not render a stop button for %s tasks", (status, stage) => {
    const run = buildGoatHarnessRun({
      task: task({ status, stage }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});

describe("TaskDetailPanel continuation composer", () => {
  it.each([
    ["succeeded", "completed"],
    ["failed", "failed"],
  ] as const)("renders the continuation composer for %s tasks", (status, stage) => {
    const run = buildGoatHarnessRun({
      task: task({ status, stage }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.getByPlaceholderText("Steer this task worker")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Continue task" })).toBeDisabled();
  });

  it.each([
    ["running", "running"],
    ["queued", "queued"],
    ["canceled", "canceled"],
  ] as const)("does not render the continuation composer for %s tasks", (status, stage) => {
    const run = buildGoatHarnessRun({
      task: task({ status, stage }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    expect(screen.queryByPlaceholderText("Steer this task worker")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue task" })).not.toBeInTheDocument();
  });

  it("submits continuation input and disables the composer while queued locally", async () => {
    const user = userEvent.setup();
    const run = buildGoatHarnessRun({
      task: task({ status: "succeeded", stage: "completed" }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    await user.type(screen.getByPlaceholderText("Steer this task worker"), "Make it shorter");
    await user.click(screen.getByRole("button", { name: "Continue task" }));

    await waitFor(() => {
      expect(mocks.continueGoatTaskAction).toHaveBeenCalledWith("TASK-1", "Make it shorter");
    });
    expect(screen.getByPlaceholderText("Task worker is running")).toBeDisabled();
  });

  it("restores input and shows the service error when continuation fails", async () => {
    mocks.continueGoatTaskAction.mockResolvedValueOnce({
      ok: false,
      error: "Only completed or failed tasks can be continued.",
    });
    const user = userEvent.setup();
    const run = buildGoatHarnessRun({
      task: task({ status: "succeeded", stage: "completed" }),
      messages: [],
      events: [],
    });

    render(<TaskDetailPanel initialRun={run} />);

    await user.type(screen.getByPlaceholderText("Steer this task worker"), "Try again");
    await user.click(screen.getByRole("button", { name: "Continue task" }));

    await waitFor(() => {
      expect(
        screen.getByText("Only completed or failed tasks can be continued."),
      ).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Steer this task worker")).toHaveValue("Try again");
    });
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
