import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StepCloudRuntimeControls, StepRuntimePicker } from "./WorkflowModelControls";

const state = vi.hoisted(() => ({
  sharedModelAccessEnabled: false,
  codexConnected: false,
  claudeCodeConnected: false,
}));
vi.mock("@/components/AppDataProvider", () => ({
  useAppDataOptional: () => state,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

async function openPicker(sharedModelAccessEnabled: boolean) {
  state.sharedModelAccessEnabled = sharedModelAccessEnabled;
  render(<StepRuntimePicker value="kimi-k3" onChange={vi.fn()} disabled={false} />);
  await userEvent.click(screen.getByRole("button", { name: "Runtime: Kimi K3" }));
}

describe("StepRuntimePicker", () => {
  beforeEach(() => {
    state.sharedModelAccessEnabled = false;
    state.codexConnected = false;
    state.claudeCodeConnected = false;
  });

  it("offers every selectable main-chat model", async () => {
    await openPicker(false);

    expect(screen.getByText("GPT 5.6 Sol")).toBeInTheDocument();
    expect(screen.getByText("Qwen 3.8 Max")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek V4 Pro")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek V4 Flash")).toBeInTheDocument();
    expect(screen.getByText("Grok 4.6")).toBeInTheDocument();
  });

  it("selects a GPT model by its workflow token", async () => {
    const onChange = vi.fn();
    state.sharedModelAccessEnabled = true;
    render(<StepRuntimePicker value="kimi-k3" onChange={onChange} disabled={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Runtime: Kimi K3" }));
    await userEvent.click(screen.getByText("GPT 5.6 Sol"));

    expect(onChange).toHaveBeenCalledWith("gpt-5.6-sol");
  });

  it("flags subscription-covered models when the workspace shares a ChatGPT subscription", async () => {
    await openPicker(true);

    expect(screen.getAllByText("Included")).toHaveLength(2);
  });

  it("hides the Included flag when no shared subscription is connected", async () => {
    await openPicker(false);

    expect(screen.queryByText("Included")).not.toBeInTheDocument();
  });

  it("separates coding agents and selects a connected sandbox runtime", async () => {
    const onChange = vi.fn();
    state.codexConnected = true;
    render(<StepRuntimePicker value="kimi-k3" onChange={onChange} disabled={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Runtime: Kimi K3" }));
    await userEvent.click(screen.getByRole("button", { name: "Coding agents" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Codex: included with your ChatGPT subscription" }),
    );

    expect(onChange).toHaveBeenCalledWith("codex");
  });

  it("marks a selected coding agent as a sandbox run", () => {
    render(<StepRuntimePicker value="codex" onChange={vi.fn()} disabled={false} />);

    expect(screen.getByRole("button", { name: "Runtime: Codex (sandbox)" })).toBeInTheDocument();
    expect(screen.getByTestId("workflow-sandbox-icon")).toBeInTheDocument();
  });
});

describe("StepCloudRuntimeControls", () => {
  it("offers Ultracode for Claude Code workflows", async () => {
    const onChange = vi.fn();
    render(
      <StepCloudRuntimeControls
        engine="claude_code"
        step={{
          id: "step_1",
          title: "Inspect",
          instructions: "Inspect the repository.",
          model: "claude-code",
          runtimeModel: "anthropic/claude-sonnet-5",
          reasoningEffort: "high",
        }}
        disabled={false}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Effort: High effort" }));
    await userEvent.click(screen.getByRole("button", { name: /^Ultracode/ }));

    expect(onChange).toHaveBeenCalledWith({ reasoningEffort: "ultracode" });
  });

  it("does not offer Ultracode for Codex workflows", async () => {
    render(
      <StepCloudRuntimeControls
        engine="codex"
        step={{
          id: "step_1",
          title: "Inspect",
          instructions: "Inspect the repository.",
          model: "codex",
          runtimeModel: "openai/gpt-5.6-sol",
          reasoningEffort: "high",
        }}
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Effort: High effort" }));

    expect(screen.queryByRole("button", { name: /^Ultracode/ })).not.toBeInTheDocument();
  });

  it("does not offer Ultracode for Claude models without XHigh reasoning", async () => {
    render(
      <StepCloudRuntimeControls
        engine="claude_code"
        step={{
          id: "step_1",
          title: "Inspect",
          instructions: "Inspect the repository.",
          model: "claude-code",
          runtimeModel: "anthropic/claude-fable-5.1",
          reasoningEffort: "high",
        }}
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Effort: High effort" }));

    expect(screen.queryByRole("button", { name: /^Ultracode/ })).not.toBeInTheDocument();
  });
});
