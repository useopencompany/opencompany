import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { PersonalRoutinesView } from "./PersonalRoutinesView";

const mocks = vi.hoisted(() => ({
  usePersonalAgent: vi.fn(),
}));

vi.mock("@/components/personal/PersonalAgentContext", () => ({
  usePersonalAgent: () => mocks.usePersonalAgent(),
}));

vi.mock("next/link", () => ({
  default: (input: ComponentProps<"a"> & { href: string }) => {
    const { href, children, ...props } = input;
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
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

describe("PersonalRoutinesView", () => {
  it("renders schedule triggers from the personal agent config", () => {
    mocks.usePersonalAgent.mockReturnValue({
      config: {
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
      },
    });

    render(<PersonalRoutinesView />);

    expect(screen.getByRole("heading", { name: "Routines" })).toBeInTheDocument();
    expect(screen.getByText("1 routine")).toBeInTheDocument();
    expect(screen.getByText("Weekdays at 09:00")).toBeInTheDocument();
    expect(screen.getByText("0 9 * * 1-5")).toBeInTheDocument();
    expect(screen.getByText("America/New_York")).toBeInTheDocument();
    expect(screen.getByText("Review yesterday's inbox.")).toBeInTheDocument();
    expect(screen.getByText("on")).toBeInTheDocument();
    expect(screen.queryByText("opencompany/web")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Behavior" })).toHaveAttribute(
      "href",
      "/personal/agent",
    );
  });

  it("shows an empty state when there are no schedules", () => {
    mocks.usePersonalAgent.mockReturnValue({ config: baseConfig });

    render(<PersonalRoutinesView />);

    expect(screen.getByText("0 routines")).toBeInTheDocument();
    expect(screen.getByText("No routines yet")).toBeInTheDocument();
  });
});
