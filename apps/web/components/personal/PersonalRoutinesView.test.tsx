import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PersonalRoutinesView } from "./PersonalRoutinesView";

const mocks = vi.hoisted(() => ({
  usePersonalAgent: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  useToast: vi.fn(() => ({ showError: vi.fn(), showToast: vi.fn() })),
  useWorkspaceContext: vi.fn(() => ({ workspaceId: "wks_123", userId: "usr_123" })),
  useQueryClient: vi.fn(() => ({})),
  runAgentScheduleNow: vi.fn(),
  updatePersonalAgentSchedules: vi.fn(),
}));

vi.mock("@/components/personal/PersonalAgentContext", () => ({
  usePersonalAgent: () => mocks.usePersonalAgent(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.useRouter(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.useQueryClient(),
}));

vi.mock("@/components/ToastProvider", () => ({
  useToast: () => mocks.useToast(),
}));

vi.mock("@/components/WorkspaceContext", () => ({
  useWorkspaceContext: () => mocks.useWorkspaceContext(),
}));

vi.mock("@/lib/agent-schedules/actions", () => ({
  runAgentScheduleNow: (...args: unknown[]) => mocks.runAgentScheduleNow(...args),
}));

vi.mock("@/lib/personal/actions", () => ({
  updatePersonalAgentSchedules: (...args: unknown[]) => mocks.updatePersonalAgentSchedules(...args),
}));

const baseConfig: AgentConfig = {
  schemaVersion: "agent.v1",
  title: "Leo",
  instructions: "Help me.",
  model: {
    provider: "vercel-ai-gateway",
    name: "openai/gpt-5.4-mini",
  },
  tools: [],
  brain: [],
  integrations: {
    github: {
      repositories: [],
    },
  },
  triggers: [],
};

function personalAgent(config: AgentConfig) {
  return {
    agent: {
      id: "agt_personal",
      name: "Leo",
      defaultModel: "openai/gpt-5.4-mini",
      path: null,
      config,
      body: "Help me.",
      content: { type: "doc", content: [] },
    },
    config,
    setConfig: vi.fn(),
    userTimezone: "America/New_York",
    userTimezoneSource: "manual",
    setUserTimezone: vi.fn(),
    setUserTimezoneSource: vi.fn(),
  };
}

describe("PersonalRoutinesView", () => {
  it("renders schedule triggers from the personal agent config", () => {
    const config: AgentConfig = {
      ...baseConfig,
      triggers: [
        {
          id: "schedule-1",
          type: "agent.schedule",
          cron: "0 9 * * 1-5",
          timezone: "America/New_York",
          prompt: "Review yesterday's inbox.",
          enabled: true,
        },
        {
          id: "pr-1",
          type: "github.pull_request",
          repository: "opencompany/web",
          events: ["opened"],
          branches: ["main"],
          enabled: true,
        },
      ],
    };
    mocks.usePersonalAgent.mockReturnValue(personalAgent(config));

    render(<PersonalRoutinesView />);

    expect(screen.getByRole("heading", { name: "Routines" })).toBeInTheDocument();
    expect(screen.getByText("1 routine")).toBeInTheDocument();
    expect(screen.getByText("Weekdays at 09:00")).toBeInTheDocument();
    expect(screen.queryByText("0 9 * * 1-5")).not.toBeInTheDocument();
    expect(screen.getByText(/Next run/)).toBeInTheDocument();
    expect(screen.getByText("Review yesterday's inbox.")).toBeInTheDocument();
    expect(screen.getByText("on")).toBeInTheDocument();
    expect(screen.queryByText("opencompany/web")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New routine" })).toBeInTheDocument();
  });

  it("shows an empty state when there are no schedules", () => {
    mocks.usePersonalAgent.mockReturnValue(personalAgent(baseConfig));

    render(<PersonalRoutinesView />);

    expect(screen.getByText("0 routines")).toBeInTheDocument();
    expect(screen.getByText("No routines yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New routine" })).toHaveLength(2);
  });

  it("opens routine creation without a per-routine timezone field", async () => {
    const user = userEvent.setup();
    mocks.usePersonalAgent.mockReturnValue(personalAgent(baseConfig));

    render(<PersonalRoutinesView />);

    await user.click(screen.getAllByRole("button", { name: "New routine" })[0]!);

    expect(screen.getAllByText("New routine").length).toBeGreaterThan(1);
    expect(screen.getByLabelText(/frequency/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/timezone/i)).not.toBeInTheDocument();
  });
});
