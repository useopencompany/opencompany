import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StepRuntimePicker } from "./WorkflowModelControls";

const state = vi.hoisted(() => ({ sharedModelAccessEnabled: false }));
vi.mock("@/components/AppDataProvider", () => ({
  useAppDataOptional: () => ({ sharedModelAccessEnabled: state.sharedModelAccessEnabled }),
}));

async function openPicker(sharedModelAccessEnabled: boolean) {
  state.sharedModelAccessEnabled = sharedModelAccessEnabled;
  render(<StepRuntimePicker value="kimi-k2.6" onChange={vi.fn()} disabled={false} />);
  await userEvent.click(screen.getByRole("button", { name: "Runtime: Kimi K2.6" }));
}

describe("StepRuntimePicker", () => {
  beforeEach(() => {
    state.sharedModelAccessEnabled = false;
  });

  it("offers the newest GPT models alongside the existing runtimes", async () => {
    await openPicker(false);

    expect(screen.getByText("GPT 5.6 Sol")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.6 Terra")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.5")).toBeInTheDocument();
  });

  it("selects a GPT model by its workflow token", async () => {
    const onChange = vi.fn();
    state.sharedModelAccessEnabled = true;
    render(<StepRuntimePicker value="kimi-k2.6" onChange={onChange} disabled={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Runtime: Kimi K2.6" }));
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
});
