import { CODEX_AGENT_MODEL_IDS, CODEX_DEFAULT_MODEL_ID } from "@opencompany/agent-runtime";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false }));

beforeAll(() => {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

describe("ModelPicker", () => {
  it("filters to Codex models when a model subset is provided", async () => {
    render(
      <ModelPicker
        value={CODEX_DEFAULT_MODEL_ID}
        fallbackModelId={CODEX_DEFAULT_MODEL_ID}
        modelIds={CODEX_AGENT_MODEL_IDS}
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Model" }));

    expect(screen.getAllByText("GPT 5.5").length).toBeGreaterThan(0);
    expect(screen.getByText("GPT 5.4")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.4 Mini")).toBeInTheDocument();
    expect(screen.queryByText("Claude Sonnet 4.6")).not.toBeInTheDocument();
  });

  it("shows the full catalog by default", async () => {
    render(
      <ModelPicker
        value="openai/gpt-5.4-mini"
        fallbackModelId="openai/gpt-5.4-mini"
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Model" }));

    expect(screen.getAllByText("GPT 5.5").length).toBeGreaterThan(0);
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
  });
});
