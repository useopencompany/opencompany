import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PersonalSettingsView from "./PersonalSettingsView";

const mocks = vi.hoisted(() => ({
  usePersonalAgent: vi.fn(),
  useTheme: vi.fn(() => ({ theme: "system", setTheme: vi.fn() })),
  useToast: vi.fn(() => ({ showError: vi.fn() })),
  resetPersonalAgent: vi.fn(),
  setProMode: vi.fn(),
  setCompanySurfaceEnabled: vi.fn(),
  setCodexEngineEnabled: vi.fn(),
  setHotContext: vi.fn(),
  setUserTimezone: vi.fn(),
}));

vi.mock("@/components/personal/PersonalAgentContext", () => ({
  usePersonalAgent: () => mocks.usePersonalAgent(),
}));

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => mocks.useTheme(),
}));

vi.mock("@/components/ToastProvider", () => ({
  useToast: () => mocks.useToast(),
}));

vi.mock("@/components/billing/BillingPanel", () => ({
  BillingPanel: () => <div data-testid="billing-panel" />,
}));

vi.mock("@/components/personal/ResetPersonalAgentDialog", () => ({
  ResetPersonalAgentDialog: () => null,
}));

vi.mock("@/components/personal/TimezonePicker", () => ({
  TimezonePicker: () => <div data-testid="timezone-picker" />,
}));

vi.mock("@/lib/personal/actions", () => ({
  resetPersonalAgent: (...args: unknown[]) => mocks.resetPersonalAgent(...args),
}));

vi.mock("@/lib/users/actions", () => ({
  setProMode: (...args: unknown[]) => mocks.setProMode(...args),
  setCompanySurfaceEnabled: (...args: unknown[]) => mocks.setCompanySurfaceEnabled(...args),
  setCodexEngineEnabled: (...args: unknown[]) => mocks.setCodexEngineEnabled(...args),
  setHotContext: (...args: unknown[]) => mocks.setHotContext(...args),
  setUserTimezone: (...args: unknown[]) => mocks.setUserTimezone(...args),
}));

function personalAgentContext(overrides: Record<string, unknown> = {}) {
  return {
    userName: "Ada Lovelace",
    userEmail: "ada@example.com",
    proMode: false,
    setProMode: vi.fn(),
    companySurfaceEnabled: false,
    setCompanySurfaceEnabled: vi.fn(),
    codexEngineEnabled: false,
    setCodexEngineEnabled: vi.fn(),
    hotContext: false,
    setHotContext: vi.fn(),
    userTimezone: "UTC",
    userTimezoneSource: "manual",
    setUserTimezone: vi.fn(),
    setUserTimezoneSource: vi.fn(),
    setConfig: vi.fn(),
    ...overrides,
  };
}

describe("PersonalSettingsView", () => {
  it("renders and saves the hot-context feature flag toggle", async () => {
    const setHotContext = vi.fn();
    mocks.usePersonalAgent.mockReturnValue(personalAgentContext({ setHotContext }));
    mocks.setHotContext.mockResolvedValue({ ok: true });

    render(<PersonalSettingsView billing={{} as never} />);

    expect(screen.getByText("Hot context (experimental)")).toBeInTheDocument();
    expect(screen.getByText(/always-present digest of your memory/)).toBeInTheDocument();
    expect(screen.getByText("Memory context injection is off.")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Enable Hot context (experimental)" }),
    );

    expect(setHotContext).toHaveBeenCalledWith(true);
    await waitFor(() => expect(mocks.setHotContext).toHaveBeenCalledWith(true));
  });
});
