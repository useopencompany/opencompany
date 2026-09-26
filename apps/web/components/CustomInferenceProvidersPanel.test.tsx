// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CustomInferenceProvidersPanel } from "./CustomInferenceProvidersPanel";

describe("CustomInferenceProvidersPanel", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the empty state and hides management actions for non-admins", () => {
    render(<CustomInferenceProvidersPanel canManage={false} />);
    expect(screen.getByText("Custom inference providers")).toBeTruthy();
    expect(screen.getByText("No custom providers yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add provider/i })).toBeNull();
  });

  it("validates required fields before saving", async () => {
    const user = userEvent.setup();
    render(<CustomInferenceProvidersPanel />);

    await user.click(screen.getByRole("button", { name: /add provider/i }));
    await user.click(screen.getByRole("button", { name: /save provider/i }));

    expect(screen.getByText("A display name is required.")).toBeTruthy();
    expect(screen.getByText("An API key is required for this provider.")).toBeTruthy();
    expect(screen.getByText("No custom providers yet")).toBeTruthy();
  });

  it("adds a provider with a masked key and untested status", async () => {
    const user = userEvent.setup();
    render(<CustomInferenceProvidersPanel />);

    await user.click(screen.getByRole("button", { name: /add provider/i }));
    await user.selectOptions(screen.getByLabelText(/provider preset/i), "groq");
    await user.type(screen.getByLabelText(/api key/i), "gsk_1234567890abcdef");
    await user.click(screen.getByRole("button", { name: /save provider/i }));

    expect(screen.getByText("Groq")).toBeTruthy();
    expect(screen.getByText("Untested")).toBeTruthy();
    expect(screen.getByText(/gsk_12••••••••cdef/)).toBeTruthy();
    expect(screen.queryByText(/gsk_1234567890abcdef/)).toBeNull();
  });

  it("marks a provider connected after a successful test", async () => {
    const user = userEvent.setup();
    render(<CustomInferenceProvidersPanel />);

    await user.click(screen.getByRole("button", { name: /add provider/i }));
    await user.type(screen.getByLabelText(/display name/i), "OpenRouter");
    await user.type(screen.getByLabelText(/api key/i), "sk-or-v1-abcdef123456");
    await user.click(screen.getByRole("button", { name: /test connection/i }));

    await screen.findByText(/connection successful/i, undefined, { timeout: 4000 });
    await user.click(screen.getByRole("button", { name: /save provider/i }));

    expect(screen.getByText(/^Connected/)).toBeTruthy();
    expect(screen.getByText("Default for chat")).toBeTruthy();
  });

  it("keeps the saved key when editing without entering a new one", async () => {
    const user = userEvent.setup();
    render(<CustomInferenceProvidersPanel />);

    await user.click(screen.getByRole("button", { name: /add provider/i }));
    await user.type(screen.getByLabelText(/display name/i), "Together");
    await user.type(screen.getByLabelText(/api key/i), "together-key-123456");
    await user.click(screen.getByRole("button", { name: /save provider/i }));

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const nameInput = screen.getByLabelText(/display name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Together (renamed)");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(screen.getByText("Together (renamed)")).toBeTruthy();
    expect(screen.getByText(/toget••••••••3456/)).toBeTruthy();
  });

  it("removes a provider after confirming", async () => {
    const user = userEvent.setup();
    render(<CustomInferenceProvidersPanel />);

    await user.click(screen.getByRole("button", { name: /add provider/i }));
    await user.type(screen.getByLabelText(/display name/i), "Fireworks");
    await user.type(screen.getByLabelText(/api key/i), "fw_123456789");
    await user.click(screen.getByRole("button", { name: /save provider/i }));

    await user.click(screen.getByRole("button", { name: "Remove" }));
    const confirm = await screen.findByText(/agents using it fall back to workspace credits/i);
    const confirmBar = confirm.parentElement as HTMLElement;
    await user.click(within(confirmBar).getByRole("button", { name: "Remove" }));

    expect(screen.queryByText("Fireworks")).toBeNull();
    expect(screen.getByText("No custom providers yet")).toBeTruthy();
  });

  it("moves the default badge when another provider is starred", async () => {
    const user = userEvent.setup();
    render(<CustomInferenceProvidersPanel />);

    for (const [name, key] of [
      ["Groq", "gsk_1234567890abcdef"],
      ["OpenRouter", "sk-or-v1-abcdef123456"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: /add provider/i }));
      await user.type(screen.getByLabelText(/display name/i), name);
      await user.type(screen.getByLabelText(/api key/i), key);
      await user.click(screen.getByRole("button", { name: /save provider/i }));
    }

    await user.click(screen.getByRole("button", { name: /set openrouter as default for chat/i }));
    const openRouterRow = screen.getByText("OpenRouter").closest("li") as HTMLElement;
    expect(within(openRouterRow).getByText("Default for chat")).toBeTruthy();
    const groqRow = screen.getByText("Groq").closest("li") as HTMLElement;
    expect(within(groqRow).queryByText("Default for chat")).toBeNull();
  });

  it("includes Ollama Cloud and self-hosted Ollama presets", async () => {
    const user = userEvent.setup();
    render(<CustomInferenceProvidersPanel />);

    await user.click(screen.getByRole("button", { name: /add provider/i }));
    const presetSelect = screen.getByLabelText(/provider preset/i);
    await user.selectOptions(presetSelect, "ollama-cloud");

    const baseUrlInput = screen.getByLabelText(/base url/i) as HTMLInputElement;
    await waitFor(() => expect(baseUrlInput.value).toBe("https://ollama.com/v1"));
    expect(screen.getByText(/ollama\.com\/settings\/keys/i)).toBeTruthy();

    await user.selectOptions(presetSelect, "ollama");
    await waitFor(() => expect(baseUrlInput.value).toBe("http://localhost:11434/v1"));
    expect(screen.getByText(/optional for local providers/i)).toBeTruthy();
  });
});
